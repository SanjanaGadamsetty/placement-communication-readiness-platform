import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers.interview import router as interview_router

_log = logging.getLogger("uvicorn.error")

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    debug=settings.debug,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(interview_router)


@app.on_event("startup")
async def _startup_checks() -> None:
    if not settings.internal_api_key or settings.internal_api_key == "change-me":
        _log.warning(
            "INTERNAL_API_KEY is not set or is the default 'change-me' value — "
            "POST /ai/config is open to any caller. Set a strong secret in .env."
        )


@app.get("/health")
def health() -> dict:
    from app.services.llm_client import get_llm_client
    provider = type(get_llm_client()).__name__
    return {
        "status": "ok",
        "service": settings.app_name,
        "version": settings.app_version,
        "llm_provider": provider,
    }
