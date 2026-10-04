from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, BackgroundTasks, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.models.schemas import (
    CombinedEvalResult,
    ConfigUpdateRequest,
    ConfigUpdateResponse,
    EvaluateResponseMetadata,
    EvaluateResponseTextRequest,
    GeneratedQuestionResponse,
    ListeningEvaluationRequest,
    ListeningEvaluationResponse,
    QuestionGenerationRequest,
    TurnEvaluationRequest,
    TurnEvaluationResponse,
)
from app.config import settings
from app.services import audio_analyzer, stt_service
from app.services.llm_client import get_llm_client, update_llm_config

router = APIRouter(prefix="/ai", tags=["interview"])


def _skills_summary(req: QuestionGenerationRequest) -> str:
    skills = ", ".join(req.skills) if req.skills else "general programming"
    projects = "; ".join(
        f"{p.title} ({', '.join(p.tech_stack)})" for p in req.projects
    ) if req.projects else "no projects listed"
    history = ""
    if req.previous_turns:
        lines = [
            f"Q{i+1} [{t.difficulty}]: {t.question_text} → score {t.technical_score}"
            for i, t in enumerate(req.previous_turns)
        ]
        history = "\nPrevious turns:\n" + "\n".join(lines)
    return (
        f"Student: {req.student_name}\n"
        f"Skills: {skills}\n"
        f"Projects: {projects}\n"
        f"Target difficulty: {req.difficulty}"
        + (f"\nDomain: {req.domain}" if req.domain else "")
        + history
    )


@router.post("/generate-question", response_model=GeneratedQuestionResponse)
def generate_question(req: QuestionGenerationRequest) -> GeneratedQuestionResponse:
    prompt = (
        "You are a technical interviewer. Generate ONE interview question.\n"
        + _skills_summary(req)
        + "\n\nRespond with valid JSON: {\"question_text\": str, \"difficulty\": str, \"category\": str}"
    )
    try:
        raw = get_llm_client().generate_question(prompt)
        return GeneratedQuestionResponse(**raw)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM error: {exc}") from exc


@router.post("/evaluate-turn", response_model=TurnEvaluationResponse)
def evaluate_turn(req: TurnEvaluationRequest) -> TurnEvaluationResponse:
    prompt = (
        "You are an interview evaluator. Score the student's answer.\n"
        f"Question [{req.difficulty}]: {req.question_text}\n"
        f"Student answer: {req.student_answer}\n"
        f"Turn number: {req.turn_number}\n\n"
        "Respond with valid JSON: "
        "{\"technical_score\": 0-10, \"communication_score\": 0-10, "
        "\"wpm\": int, \"filler_words\": int, \"feedback\": str, "
        "\"strengths\": str, \"weaknesses\": str, "
        "\"next_recommended_difficulty\": \"EASY\"|\"MEDIUM\"|\"ADVANCED\"}"
    )
    try:
        raw = get_llm_client().evaluate_turn(prompt)
        return TurnEvaluationResponse(**raw)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM error: {exc}") from exc


@router.post("/evaluate-listening", response_model=ListeningEvaluationResponse)
def evaluate_listening(req: ListeningEvaluationRequest) -> ListeningEvaluationResponse:
    prompt = (
        "You are a listening comprehension evaluator.\n"
        f"Story: {req.story_text}\n"
        f"Question: {req.question}\n"
        f"Expected answer: {req.expected_answer}\n"
        f"Student answer: {req.student_answer}\n\n"
        "Respond with valid JSON: "
        "{\"score\": 0-10, \"accuracy_level\": \"HIGH\"|\"MEDIUM\"|\"LOW\", "
        "\"feedback\": str, \"missed_key_points\": [str]}"
    )
    try:
        raw = get_llm_client().evaluate_listening(prompt)
        return ListeningEvaluationResponse(**raw)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM error: {exc}") from exc


# Fix 7: background task for signal analysis (runs after SSE response is sent)
async def _compute_signal_metrics_bg(audio_bytes: bytes, session_id: str, turn_number: int) -> None:
    try:
        metrics = await audio_analyzer.analyze_signal(audio_bytes)
        # Metrics available here for future Redis storage or push via separate channel
        # Currently computed for correctness; can be stored with:
        # await redis.set(f"session:{session_id}:turn:{turn_number}:signal", metrics.model_dump_json(), ex=3600)
    except Exception as e:
        print(f"[interview] background signal analysis error: {e}")


@router.post("/evaluate-response")
async def evaluate_response(
    audio: UploadFile = File(...),
    metadata: str = Form(...),
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> StreamingResponse:
    """
    POST /ai/evaluate-response — multipart/form-data, returns text/event-stream SSE.

    SSE event types:
      text_chunk  — raw LLM token delta  {"type": "text_chunk", "text": "..."}
      text_end    — LLM stream finished  {"type": "text_end"}
      result      — full parsed response {"type": "result", "data": CombinedEvalResult}
      error       — pipeline failure     {"type": "error", "message": "..."}

    Architecture:
      Stage 1 (parallel): STT  ∥  pgvector retrieval (signal moved to background)
      Stage 2 (streaming): conduct_interview_stream() — yields LLM token chunks
      Stage 3 (background): upsert context_summary to pgvector + signal analysis (non-blocking)
      Stage 4 (sync): compute filler-based metrics from transcript only
    """
    from app.services.vector_store import retrieve_relevant, upsert_summary

    try:
        meta = EvaluateResponseMetadata.model_validate_json(metadata)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid metadata JSON: {exc}") from exc

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio payload")

    async def _stream():
        # Stage 1: parallel STT + pgvector (signal analysis moved to background — Fix 7)
        stt_task = asyncio.create_task(stt_service.transcribe(audio_bytes))

        # Fix 5: skip pgvector on turn 1 — no embeddings exist yet
        if meta.turn_number > 1:
            vector_task: asyncio.Task | None = asyncio.create_task(
                retrieve_relevant(session_id=meta.session_id, query_text=meta.question_text, top_k=3)
            )
        else:
            vector_task = None

        # Fix 6: 30s timeout on Stage 1 gather
        try:
            if vector_task is not None:
                transcript, long_term_chunks = await asyncio.wait_for(
                    asyncio.gather(stt_task, vector_task),
                    timeout=30.0,
                )
            else:
                transcript = await asyncio.wait_for(stt_task, timeout=30.0)
                long_term_chunks = []
        except asyncio.TimeoutError:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Stage 1 timeout after 30s'})}\n\n"
            return
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'Stage 1 error: {exc}'})}\n\n"
            return

        # Stage 2: stream LLM tokens
        full_response = ""
        try:
            async for chunk in get_llm_client().conduct_interview_stream(
                transcript=transcript,
                meta=meta,
                long_term_chunks=long_term_chunks,
            ):
                full_response += chunk
                yield f"data: {json.dumps({'type': 'text_chunk', 'text': chunk})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'LLM error: {exc}'})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'text_end'})}\n\n"

        # Parse accumulated JSON
        try:
            raw = json.loads(full_response)
        except json.JSONDecodeError as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'JSON parse error: {exc}'})}\n\n"
            return

        is_clarification = bool(raw.get("is_clarification", False))
        tech_score = 0.0 if is_clarification else float(raw.get("technical_score", 5.0))
        context_summary = "" if is_clarification else str(raw.get("context_summary", ""))

        # Stage 3: background vector upsert + signal analysis — skipped for clarifications
        if not is_clarification:
            if context_summary and meta.session_id:
                background_tasks.add_task(
                    upsert_summary,
                    meta.session_id,
                    meta.turn_number,
                    context_summary,
                )
            background_tasks.add_task(
                _compute_signal_metrics_bg,
                audio_bytes,
                meta.session_id,
                meta.turn_number,
            )

        # Stage 4: transcript-only metrics (no blocking signal analysis on critical path)
        filler_count = audio_analyzer.count_fillers(transcript)
        clarity_score = max(0.0, 100.0 - filler_count * 5.0)

        result = CombinedEvalResult(
            transcript=transcript,
            stt_raw=transcript,
            technical_score=tech_score,
            feedback="" if is_clarification else str(raw.get("feedback", "")),
            strengths="" if is_clarification else str(raw.get("strengths", "")),
            weaknesses="" if is_clarification else str(raw.get("weaknesses", "")),
            next_recommended_difficulty=str(raw.get("next_recommended_difficulty", "EASY")),
            conversational_response=str(raw.get("conversational_response", "")),
            next_question_text="" if is_clarification else str(raw.get("next_question_text", "")),
            rubric_for_next_question={} if is_clarification else (raw.get("rubric_for_next_question") or {}),
            update_state={} if is_clarification else (raw.get("update_state") or {}),
            context_summary=context_summary,
            pace_wpm=0.0,
            filler_count=0 if is_clarification else filler_count,
            fluency_score=0.0 if is_clarification else round(max(0.0, 100.0 - filler_count * 3.0), 1),
            clarity_score=0.0 if is_clarification else round(clarity_score, 1),
            is_clarification=is_clarification,
        )

        yield f"data: {json.dumps({'type': 'result', 'data': result.model_dump()})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.post("/evaluate-response-text")
async def evaluate_response_text(
    req: EvaluateResponseTextRequest,
    background_tasks: BackgroundTasks = BackgroundTasks(),
) -> StreamingResponse:
    """
    POST /ai/evaluate-response-text — accepts pre-transcribed text, returns text/event-stream SSE.

    Used by the Deepgram streaming path (Phase 1): Node.js sends the Deepgram transcript
    instead of a WAV file, skipping Groq Whisper and audio signal analysis entirely.

    SSE format is identical to /ai/evaluate-response so Node.js can reuse consumeAIStream().
    """
    from app.services.vector_store import retrieve_relevant, upsert_summary

    meta = req.metadata
    transcript = req.transcript

    async def _stream():
        # Stage 1: pgvector retrieval only (no STT — transcript already provided)
        if meta.turn_number > 1:
            vector_task: asyncio.Task | None = asyncio.create_task(
                retrieve_relevant(session_id=meta.session_id, query_text=meta.question_text, top_k=3)
            )
            try:
                long_term_chunks = await asyncio.wait_for(vector_task, timeout=10.0)
            except asyncio.TimeoutError:
                long_term_chunks = []
        else:
            long_term_chunks = []

        # Stage 2: stream LLM tokens
        full_response = ""
        try:
            async for chunk in get_llm_client().conduct_interview_stream(
                transcript=transcript,
                meta=meta,
                long_term_chunks=long_term_chunks,
            ):
                full_response += chunk
                yield f"data: {json.dumps({'type': 'text_chunk', 'text': chunk})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'LLM error: {exc}'})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'text_end'})}\n\n"

        try:
            raw = json.loads(full_response)
        except json.JSONDecodeError as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'JSON parse error: {exc}'})}\n\n"
            return

        is_clarification = bool(raw.get("is_clarification", False))
        tech_score = 0.0 if is_clarification else float(raw.get("technical_score", 5.0))
        context_summary = "" if is_clarification else str(raw.get("context_summary", ""))

        # Stage 3: background vector upsert — skipped for clarifications
        if not is_clarification and context_summary and meta.session_id:
            background_tasks.add_task(
                upsert_summary,
                meta.session_id,
                meta.turn_number,
                context_summary,
            )

        # Stage 4: transcript-only metrics (no audio — filler count only)
        filler_count = audio_analyzer.count_fillers(transcript)
        clarity_score = max(0.0, 100.0 - filler_count * 5.0)

        result = CombinedEvalResult(
            transcript=transcript,
            stt_raw=transcript,
            technical_score=tech_score,
            feedback="" if is_clarification else str(raw.get("feedback", "")),
            strengths="" if is_clarification else str(raw.get("strengths", "")),
            weaknesses="" if is_clarification else str(raw.get("weaknesses", "")),
            next_recommended_difficulty=str(raw.get("next_recommended_difficulty", "EASY")),
            conversational_response=str(raw.get("conversational_response", "")),
            next_question_text="" if is_clarification else str(raw.get("next_question_text", "")),
            rubric_for_next_question={} if is_clarification else (raw.get("rubric_for_next_question") or {}),
            update_state={} if is_clarification else (raw.get("update_state") or {}),
            context_summary=context_summary,
            pace_wpm=0.0,
            filler_count=0 if is_clarification else filler_count,
            fluency_score=0.0 if is_clarification else round(max(0.0, 100.0 - filler_count * 3.0), 1),
            clarity_score=0.0 if is_clarification else round(clarity_score, 1),
            is_clarification=is_clarification,
        )

        yield f"data: {json.dumps({'type': 'result', 'data': result.model_dump()})}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.post("/config", response_model=ConfigUpdateResponse)
def update_config(
    req: ConfigUpdateRequest,
    x_internal_key: str | None = Header(default=None),
) -> ConfigUpdateResponse:
    # Guard: require the shared secret so arbitrary callers cannot replace the LLM key.
    if x_internal_key != settings.internal_api_key:
        raise HTTPException(status_code=403, detail="Missing or invalid X-Internal-Key")
    active = update_llm_config(
        provider=req.llm_provider,
        base_url=req.llm_base_url,
        api_key=req.groq_api_key,
        model=req.groq_model,
    )
    return ConfigUpdateResponse(status="updated", active_provider=active)
