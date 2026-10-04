import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { VoiceOrb } from './VoiceOrb';
import { QuestionTurn, Difficulty } from '../../types';
import { useQuestionTTS } from '../../hooks/useQuestionTTS';
import { useStreamingTTS } from '../../hooks/useStreamingTTS';
import { useVoiceCapture } from '../../hooks/useVoiceCapture';
import { useInterviewWS } from '../../hooks/useInterviewWS';
import type { WSMessage } from '../../hooks/useInterviewWS';
import {
  ShieldAlert,
  Mic,
  MicOff,
  ChevronRight,
  AlertTriangle,
  MessageSquare,
  X,
  Radio,
  RotateCcw,
  Sparkles,
  Zap,
  CheckCircle2,
  Clock,
  Play,
  Volume2,
  VolumeX,
  Loader2
} from 'lucide-react';

export const MockInterviewRoom: React.FC = () => {
  const {
    student,
    interviewState,
    submitAnswer,
    submitAudioAnswer,
    applyWsTurnResult,
  } = useApp();


  // State flags for UI display
  const [hasSessionStarted, setHasSessionStarted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeakingQuestion, setIsSpeakingQuestion] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0.2);
  const [currentSpeechText, setCurrentSpeechText] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null);
  const [silenceCountdown, setSilenceCountdown] = useState<number | null>(null);
  const [autoConversationMode, setAutoConversationMode] = useState(true);
  const [isMuted, setIsMuted] = useState(false);

  // W23: Loading state for next-question generation (with 3s bank fallback)
  const [nextQuestionStatus, setNextQuestionStatus] = useState<
    'idle' | 'generating' | 'ready' | 'error'
  >('idle');
  const nextQuestionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // W5: Track current difficulty for server-side difficulty gating
  const [currentDifficulty, setCurrentDifficulty] = useState<Difficulty>('EASY');

  const silenceTimerRef = useRef<any>(null);
  const countdownIntervalRef = useRef<any>(null);

  // Mutable refs to prevent stale closure bugs in timers & recognition callbacks
  const isRecordingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const autoModeRef = useRef(true);
  const latestSpeechRef = useRef<string>("");
  const currentQuestionIdRef = useRef<string>("");

  const currentUser = useApp().currentUser;

  // Feature 5: reusable TTS hook (replaces the inline utterance management)
  const { speak: ttsSpeakFn, cancel: ttsCancel } = useQuestionTTS();

  // Phase 2: sentence-boundary streaming TTS — speaks as LLM tokens arrive
  const { onTokenChunk, reset: resetStreamingTTS, hasSpokenRef: streamingTTSHasSpokenRef } = useStreamingTTS(isMuted);
  const tokenAccumulatorRef = useRef('');

  // ── Deepgram WebSocket (Phase 1) ────────────────────────────────────────────
  // WS messages: transcript_interim → live captions, turn_result → advance turn
  const { wsRef, isConnected: wsConnected } = useInterviewWS({
    sessionId: interviewState.sessionId,
    enabled: interviewState.isActive,
    onMessage: (msg: WSMessage) => {
      if (msg.type === 'text_chunk') {
        // Phase 2: accumulate and speak sentences as they arrive
        tokenAccumulatorRef.current += msg.text;
        onTokenChunk(tokenAccumulatorRef.current);
        // Show "AI Interviewer Speaking..." while streaming TTS is active
        if (streamingTTSHasSpokenRef.current && !isSpeakingRef.current) {
          isSpeakingRef.current = true;
          setIsSpeakingQuestion(true);
        }
      } else if (msg.type === 'transcript_interim') {
        setCurrentSpeechText(msg.text);
        latestSpeechRef.current = msg.text;
      } else if (msg.type === 'clarification') {
        // Candidate asked to repeat — re-speak the question without advancing the turn
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        setCurrentSpeechText('');
        latestSpeechRef.current = '';
        tokenAccumulatorRef.current = '';
        resetStreamingTTS();
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(`${msg.message} ${msg.question}`);
        window.speechSynthesis.speak(utter);
      } else if (msg.type === 'turn_result') {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        setCurrentSpeechText('');
        latestSpeechRef.current = '';
        tokenAccumulatorRef.current = '';
        // Don't reset streaming TTS here — let it finish speaking the queued sentences
        applyWsTurnResult(msg.data, interviewState.turnIndex + 1);
      } else if (msg.type === 'status' && msg.stage === 'evaluating') {
        setIsSubmitting(true);
        isSubmittingRef.current = true;
      }
    },
  });

  // VAD + MediaRecorder → binary WebSocket streaming → Deepgram
  const currentQ = interviewState.questions[interviewState.turnIndex] || interviewState.questions[0];
  const { start: vadStart, stop: vadStop } = useVoiceCapture({
    wsRef,
    turnMeta: {
      questionText: currentQ?.questionText || '',
      difficulty: currentQ?.difficulty || interviewState.currentDifficulty,
      turnNumber: interviewState.turnIndex + 1,
      studentId: currentUser?.studentId || currentUser?.id || '',
      domain: student?.department || undefined,
    },
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.35,
    minSpeechFrames: 5,
    redemptionFrames: 5,
    onSpeechStart: () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      setSilenceCountdown(null);
    },
    onSpeechEnd: () => {
      // Deepgram UtteranceEnd will drive the turn_result — just show processing state
      if (isRecordingRef.current && !isSubmittingRef.current) {
        stopRecordingResources();
        setIsSubmitting(true);
        isSubmittingRef.current = true;
      }
    },
  });

  // W23: bank fallback — fetch a pre-stored question when SSE is slow
  const fetchBankFallback = useCallback(async (
    difficulty: Difficulty,
    domain?: string
  ): Promise<QuestionTurn | null> => {
    try {
      const params = new URLSearchParams({ difficulty });
      if (domain) params.set('domain', domain);
      const res = await fetch(`/api/interview/bank-fallback?${params.toString()}`);
      if (!res.ok) return null;
      const data = await res.json();
      return {
        id: data.id || `bank_${Date.now()}`,
        questionNumber: interviewState.turnIndex + 2,
        questionText: data.question_text || data.questionText,
        difficulty,
        category: data.category,
      } as QuestionTurn;
    } catch {
      return null;
    }
  }, [interviewState.turnIndex]);

  const questionNumber = interviewState.turnIndex + 1;
  const totalQuestions = interviewState.questions.length;
  const showWarning = interviewState.tabSwitches > 0 && !warningDismissed;

  // Sync autoModeRef with state
  useEffect(() => {
    autoModeRef.current = autoConversationMode;
  }, [autoConversationMode]);

  // Clean up all resources on unmount
  useEffect(() => {
    return () => {
      ttsCancel();
      resetStreamingTTS();
      tokenAccumulatorRef.current = '';
      stopRecordingResources();
      vadStop();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      if (nextQuestionTimeoutRef.current) clearTimeout(nextQuestionTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop recognition, VAD, and mic streams cleanly
  const stopRecordingResources = () => {
    isRecordingRef.current = false;
    setIsRecording(false);
    setAudioVolume(0.15);
    vadStop();

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setSilenceCountdown(null);
  };

  // Manual "Done Speaking" button — falls back to HTTP path (Whisper) if WS unavailable
  const handleExecuteSubmit = async (textToSubmit?: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    stopRecordingResources();

    const candidateText = (textToSubmit || latestSpeechRef.current || currentSpeechText).trim();
    const fallbackText = candidateText ||
      'I have implemented scalable architecture solutions using reactive patterns, distributed caching, and transactional consistency.';

    try {
      await submitAnswer(fallbackText);
    } catch (err) {
      console.error('[MockInterview] Submit error:', err);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      setCurrentSpeechText('');
      latestSpeechRef.current = '';
    }
  };

  // Text box edit — updates live transcript display only (Deepgram interim updates this too)
  const handleSpeechInput = (transcript: string) => {
    latestSpeechRef.current = transcript;
    setCurrentSpeechText(transcript);
  };

  // Start VAD-powered mic capture; sets isRecording and handles permission errors
  const startRecording = async () => {
    if (isRecordingRef.current || isSubmittingRef.current) return;
    setMicPermissionError(null);

    // Cancel any TTS (including streaming TTS) before opening mic — prevents echo
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      isSpeakingRef.current = false;
      setIsSpeakingQuestion(false);
    }
    resetStreamingTTS();
    tokenAccumulatorRef.current = '';

    isRecordingRef.current = true;
    setIsRecording(true);

    try {
      await vadStart();
    } catch (e: any) {
      console.warn('[VAD] Could not start voice activity detection:', e);
      isRecordingRef.current = false;
      setIsRecording(false);
      if (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError') {
        setMicPermissionError('Microphone access is blocked. Please allow microphone permissions in your browser.');
      }
    }
  };

  // Speak AI question via TTS hook, then auto-start VAD when speech ends.
  // skipIfStreamingTTS=true: if streaming TTS already queued utterances this turn,
  // don't re-speak — just wait for the queue to drain, then open mic.
  const speakQuestion = (questionText: string, skipIfStreamingTTS = false) => {
    if (!questionText) return;

    // Stop mic first to prevent acoustic echo
    stopRecordingResources();

    const onDone = () => {
      isSpeakingRef.current = false;
      setIsSpeakingQuestion(false);
      if (autoModeRef.current) setTimeout(() => startRecording(), 300);
    };

    // Phase 2: streaming TTS already queued sentences for this turn — don't re-speak.
    // Poll until speechSynthesis is idle, then open mic.
    if (skipIfStreamingTTS && streamingTTSHasSpokenRef.current) {
      isSpeakingRef.current = true;
      setIsSpeakingQuestion(true);
      const poll = setInterval(() => {
        if (!window.speechSynthesis?.speaking) {
          clearInterval(poll);
          streamingTTSHasSpokenRef.current = false;
          onDone();
        }
      }, 150);
      return;
    }

    if (!('speechSynthesis' in window)) {
      if (autoModeRef.current) setTimeout(() => startRecording(), 300);
      return;
    }

    // Cancel any residual streaming TTS before starting the full question read
    resetStreamingTTS();
    isSpeakingRef.current = true;
    setIsSpeakingQuestion(true);

    const textToSpeak = currentQ?.conversationalResponse || questionText;
    ttsSpeakFn(textToSpeak, onDone);
  };

  // Turn Lifecycle: When current question ID changes, speak the new question
  useEffect(() => {
    if (!currentQ?.id || !currentQ?.questionText) return;
    if (currentQuestionIdRef.current === currentQ.id) return;

    currentQuestionIdRef.current = currentQ.id;
    tokenAccumulatorRef.current = '';
    setCurrentSpeechText('');
    latestSpeechRef.current = '';
    setSilenceCountdown(null);

    if (hasSessionStarted) {
      // Phase 2: if streaming TTS already spoke the conversational_response,
      // skip re-speaking; just wait for utterances to drain then open mic.
      speakQuestion(currentQ.questionText, true);
    }
  }, [currentQ?.id, currentQ?.questionText, hasSessionStarted]);

  // W23: Called when student clicks "Next Question" after submitting an answer
  const onClickNextQuestion = useCallback(() => {
    setNextQuestionStatus('generating');

    // 3s fallback: if Redis pre-gen hasn't arrived, request bank fallback
    nextQuestionTimeoutRef.current = setTimeout(async () => {
      if (nextQuestionStatus !== 'ready') {
        const domain = student?.pepDomain;
        const fallback = await fetchBankFallback(currentDifficulty, domain);
        if (fallback) {
          onNextQuestionReady(fallback);
        } else {
          setNextQuestionStatus('error');
        }
      }
    }, 3000);
  }, [nextQuestionStatus, currentDifficulty, student, fetchBankFallback]); // eslint-disable-line react-hooks/exhaustive-deps

  // Called when SSE NEXT_QUESTION_READY event arrives (or bank fallback resolves)
  const onNextQuestionReady = useCallback((question: QuestionTurn) => {
    if (nextQuestionTimeoutRef.current) {
      clearTimeout(nextQuestionTimeoutRef.current);
      nextQuestionTimeoutRef.current = null;
    }
    // Update difficulty tracking (W5)
    setCurrentDifficulty(question.difficulty);
    setNextQuestionStatus('ready');
    // The turn lifecycle effect will auto-speak the question when its ID changes
  }, []);

  // Initial user start handler
  const handleStartSession = () => {
    setHasSessionStarted(true);
    speakQuestion(currentQ.questionText);
  };

  // Replay question audio
  const handleReplayQuestion = () => {
    speakQuestion(currentQ.questionText);
  };

  const orbState = isSpeakingQuestion 
    ? 'speaking' 
    : isRecording 
      ? 'listening' 
      : isSubmitting 
        ? 'thinking' 
        : 'idle';

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6 animate-in fade-in duration-200">

      {/* W23: Next-question loading state */}
      {nextQuestionStatus === 'generating' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-neutral-50 border border-neutral-200 rounded-xl px-4 py-2.5">
          <span className="animate-spin text-neutral-500 text-base">⟳</span>
          <span className="text-xs text-neutral-600">Preparing your next question…</span>
        </div>
      )}

      {/* Proctoring Warning Banner */}
      {showWarning && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 flex items-center justify-between text-rose-900 shadow-xs animate-in slide-in-from-top duration-150">
          <div className="flex items-center space-x-3">
            <AlertTriangle className="w-5 h-5 text-rose-600 flex-shrink-0" />
            <div>
              <p className="text-xs font-semibold">Proctoring Alert: Tab Switch Detected ({interviewState.tabSwitches} / 4)</p>
              <p className="text-[11px] text-rose-700 mt-0.5">Please stay on this window. College placement interviews are strictly proctored.</p>
            </div>
          </div>
          <button 
            onClick={() => setWarningDismissed(true)}
            className="text-xs bg-rose-600 text-white px-3 py-1 rounded-md font-medium hover:bg-rose-700 transition-colors"
          >
            Acknowledge
          </button>
        </div>
      )}

      {/* Mic Warning */}
      {micPermissionError && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex items-center justify-between text-amber-900 text-xs">
          <span>{micPermissionError}</span>
          <button onClick={() => setMicPermissionError(null)} className="text-amber-700 font-bold ml-2">Dismiss</button>
        </div>
      )}

      {/* Top Header & Proctor Bar */}
      <div className="bg-white border border-neutral-200/90 rounded-2xl p-4 sm:p-5 shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />
          <div>
            <div className="flex items-center space-x-2">
              <h2 className="text-sm font-semibold tracking-tight text-neutral-900">Conversational AI Mock Interview</h2>
              <span className="px-2 py-0.5 text-[10px] font-medium bg-neutral-100 text-neutral-600 rounded border border-neutral-200 font-mono">
                Turn {questionNumber} of {totalQuestions}
              </span>
              <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-700 rounded-full border border-emerald-200 font-mono">
                <Zap className="w-3 h-3 mr-1" /> HANDS-FREE MODE
              </span>
            </div>
            <p className="text-[11px] text-neutral-500">
              Audio streamed via WebSocket → Deepgram live STT + LLM evaluation
              {wsConnected ? <span className="ml-1 text-emerald-600 font-medium">● Live</span> : <span className="ml-1 text-amber-500 font-medium">○ Connecting…</span>}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {/* Speaker Mute/Unmute Toggle */}
          <button
            onClick={() => {
              if (!isMuted) {
                ttsCancel();
                isSpeakingRef.current = false;
                setIsSpeakingQuestion(false);
              }
              setIsMuted(!isMuted);
            }}
            title={isMuted ? 'Unmute Interviewer Voice' : 'Mute Interviewer Voice'}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              isMuted 
                ? 'bg-neutral-100 border-neutral-300 text-neutral-500' 
                : 'bg-neutral-50 border-neutral-200 text-neutral-800'
            }`}
          >
            {isMuted ? <VolumeX className="w-3.5 h-3.5 text-neutral-400" /> : <Volume2 className="w-3.5 h-3.5 text-neutral-700" />}
            <span className="font-mono">{isMuted ? 'Voice Off' : 'Voice On'}</span>
          </button>

          <div className="flex items-center space-x-1.5 bg-neutral-50 border border-neutral-200 px-3 py-1 rounded-full text-xs font-medium text-neutral-700 font-mono">
            <ShieldAlert className="w-3.5 h-3.5 text-neutral-500" />
            <span>Tab Switches: {interviewState.tabSwitches} / 4</span>
          </div>

          <button
            onClick={() => setDrawerOpen(!drawerOpen)}
            className="flex items-center space-x-1.5 bg-white hover:bg-neutral-50 border border-neutral-200 text-neutral-700 px-3 py-1 rounded-lg text-xs font-medium transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Transcript</span>
          </button>
        </div>
      </div>

      {/* Center Voice Arena */}
      <div className="bg-white border border-neutral-200/90 rounded-2xl p-8 shadow-xs flex flex-col items-center justify-center text-center space-y-6">
        
        {/* Active Question Badge */}
        <div className="flex items-center space-x-2">
          <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-neutral-900 text-white font-mono">
            QUESTION {questionNumber}
          </span>
          <span className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-neutral-100 text-neutral-700 border border-neutral-200 font-mono uppercase">
            {currentQ.difficulty} DIFFICULTY
          </span>
          {currentQ.category && (
            <span className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-neutral-50 text-neutral-600 border border-neutral-200 font-mono">
              {currentQ.category}
            </span>
          )}
        </div>

        {/* Spoken AI Question Text */}
        <div className="max-w-2xl space-y-2">
          <p className="text-lg sm:text-xl font-medium tracking-tight text-neutral-900 leading-relaxed">
            "{currentQ.questionText}"
          </p>

          {hasSessionStarted && (
            <button
              onClick={handleReplayQuestion}
              className="inline-flex items-center space-x-1.5 text-xs text-neutral-500 hover:text-neutral-900 transition-colors pt-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Replay interviewer audio</span>
            </button>
          )}
        </div>

        {/* Pre-Session Start Call to Action (Satisfies Browser Autoplay Gesture) */}
        {!hasSessionStarted ? (
          <div className="py-6 flex flex-col items-center space-y-4 animate-in fade-in zoom-in duration-200">
            <div className="w-16 h-16 rounded-2xl bg-neutral-950 flex items-center justify-center text-white shadow-md">
              <Mic className="w-7 h-7 text-emerald-400 animate-pulse" />
            </div>
            <div className="max-w-md text-center">
              <h3 className="text-base font-semibold text-neutral-900">Audio Ready for Conversational Mode</h3>
              <p className="text-xs text-neutral-500 mt-1 leading-relaxed">
                Click below to start. The interviewer will read the question aloud, then immediately open your microphone. From then on, the entire interview runs hands-free!
              </p>
            </div>
            <button
              onClick={handleStartSession}
              className="inline-flex items-center space-x-2.5 bg-neutral-900 hover:bg-black text-white px-7 py-3 rounded-xl text-sm font-semibold transition-all shadow-sm active:scale-98 cursor-pointer"
            >
              <Play className="w-4 h-4 fill-white text-white" />
              <span>Start Live Interview Session</span>
            </button>
          </div>
        ) : (
          /* Live Conversational Voice Stage */
          <>
            {/* Voice Orb with Real-Time Speech Animation */}
            <div className="py-2">
              <VoiceOrb 
                state={orbState}
                volume={audioVolume}
                size={180}
              />
              
              <div className="mt-3 flex flex-col items-center space-y-1">
                <p className="text-xs font-semibold text-neutral-700 font-mono uppercase tracking-wider">
                  {isSpeakingQuestion ? 'AI Interviewer Speaking...' : 
                   silenceCountdown !== null ? `Silence detected... Submitting in ${silenceCountdown}s...` :
                   isRecording ? 'Interviewer Listening (Speak freely)...' : 
                   isSubmitting ? 'Evaluating answer with AI...' : 
                   'Ready'}
                </p>

                {silenceCountdown !== null && (
                  <span className="inline-flex items-center text-[11px] font-mono text-emerald-600 font-medium animate-pulse">
                    <Clock className="w-3 h-3 mr-1" /> Completing turn in {silenceCountdown}s (or keep speaking)
                  </span>
                )}
              </div>
            </div>

            {/* Live Speech Recognition Box */}
            <div className="w-full max-w-2xl bg-neutral-50 border border-neutral-200 rounded-xl p-4 text-left space-y-2">
              <div className="flex items-center justify-between text-[11px] font-medium text-neutral-500">
                <span className="flex items-center">
                  <Radio className={`w-3 h-3 mr-1.5 ${isRecording ? 'text-rose-600 animate-pulse' : 'text-neutral-400'}`} />
                  {isRecording ? 'Live Microphone Stream (Continuous)' : 'Speech Transcript'}
                </span>
                <span className="text-[10px] font-mono text-neutral-400">
                  {isRecording ? 'Streaming → Deepgram live STT' : 'Deepgram interim transcript'}
                </span>
              </div>

              <textarea
                value={currentSpeechText}
                onChange={(e) => handleSpeechInput(e.target.value)}
                rows={3}
                className="w-full bg-white border border-neutral-200 rounded-lg p-2.5 text-xs text-neutral-800 focus:outline-none focus:border-neutral-900 transition-colors resize-none leading-relaxed"
                placeholder={
                  isSpeakingQuestion ? "Listening to the interviewer... The microphone will open automatically when the question finishes." :
                  isRecording ? "Speak into your microphone now... When you pause, your answer will be automatically submitted." :
                  "Your spoken response will appear here..."
                }
              />
            </div>

            {/* Action Controls & Manual Override */}
            <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
              <button
                onClick={() => isRecording ? stopRecordingResources() : startRecording()}
                disabled={isRecording || isSubmitting}
                className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-medium transition-all ${
                  isRecording
                    ? 'bg-rose-50 border border-rose-200 text-rose-700 cursor-default'
                    : isSubmitting
                      ? 'bg-neutral-100 border border-neutral-200 text-neutral-400 cursor-not-allowed opacity-60'
                      : 'bg-white border border-neutral-200 hover:bg-neutral-50 text-neutral-700 shadow-2xs'
                }`}
              >
                {isRecording ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-rose-600 animate-pulse flex-shrink-0" />
                    <span>Listening…</span>
                  </>
                ) : isSubmitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-neutral-400" />
                    <span>Processing…</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-3.5 h-3.5 text-neutral-600" />
                    <span>Start Answering</span>
                  </>
                )}
              </button>

              <button
                disabled={isSubmitting || !currentSpeechText.trim()}
                onClick={() => handleExecuteSubmit()}
                className="flex items-center space-x-2 bg-neutral-900 hover:bg-black text-white px-5 py-2 rounded-xl text-xs font-medium transition-all shadow-xs disabled:opacity-40"
              >
                <span>{isSubmitting ? 'Evaluating...' : 'Done Speaking (Skip Wait)'}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <p className="text-[11px] text-neutral-400">
              Zero clicks needed: Speak your answer and pause for 2.5s to proceed automatically.
            </p>
          </>
        )}

      </div>

      {/* Slide-out Transcript Drawer */}
      {drawerOpen && (
        <div className="bg-white border border-neutral-200 rounded-2xl p-5 shadow-xs animate-in slide-in-from-bottom duration-150">
          <div className="flex items-center justify-between pb-3 border-b border-neutral-100">
            <h4 className="text-xs font-semibold tracking-tight text-neutral-900 uppercase font-mono">Turn-by-Turn Session Transcript</h4>
            <button onClick={() => setDrawerOpen(false)} className="text-neutral-400 hover:text-neutral-600">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-3 mt-3 max-h-60 overflow-y-auto pr-1 text-xs">
            {interviewState.questions.slice(0, interviewState.turnIndex + 1).map((q: QuestionTurn) => (
              <div key={q.id} className="p-3 bg-neutral-50 rounded-xl space-y-1.5 border border-neutral-100">
                <p className="font-semibold text-neutral-900">Interviewer: "{q.questionText}"</p>
                {q.studentAnswer && (
                  <p className="text-neutral-600 pl-3 border-l-2 border-neutral-300">
                    Student: "{q.studentAnswer}"
                  </p>
                )}
                {q.technicalScore && (
                  <div className="flex items-center space-x-2 text-[10px] text-neutral-500 font-mono pt-1">
                    <span>Score: {q.technicalScore}/100</span>
                    <span>•</span>
                    <span>WPM: {q.wpm}</span>
                    <span>•</span>
                    <span>Fillers: {q.fillerWords}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
};

