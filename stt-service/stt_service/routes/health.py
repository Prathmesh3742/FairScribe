"""
FairScribe STT Service — Health Check Route

GET /api/health

Returns the overall service status, engine availability, active sessions,
and relevant configuration. This is the first endpoint the Electron main
process calls on startup to verify the STT service is running and ready.

The health check is intentionally lightweight — it does NOT perform any
inference. It only checks whether models are loaded.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from ..models import HealthResponse
from .. import __version__

router = APIRouter(prefix="/api", tags=["health"])

# Service start time (set when the module is first imported)
_start_time = time.monotonic()


@router.get("/health", response_model=HealthResponse)
async def health_check(request: Request) -> HealthResponse:
    """
    Service health check.

    Returns:
        - Overall status ("ok" or "degraded")
        - Service version
        - Uptime in seconds
        - Per-engine health (VAD, Vosk, Whisper)
        - Active session count
        - Non-sensitive config summary
    """
    manager = request.app.state.session_manager
    settings = request.app.state.settings

    engine_health = manager.get_engine_health()

    # Determine overall status
    vosk_ok = engine_health["vosk"].model_loaded
    overall = "ok" if vosk_ok else "degraded"

    return HealthResponse(
        status=overall,
        version=__version__,
        uptime_seconds=round(time.monotonic() - _start_time, 1),
        engines=engine_health,
        active_sessions=manager.active_session_count,
        config={
            "host": settings.host,
            "port": settings.port,
            "sample_rate": settings.audio.sample_rate,
            "vad_enabled": settings.vad.enabled,
            "whisper_enabled": settings.whisper.enabled,
            "whisper_model": settings.whisper.model_size,
            "vosk_model": settings.vosk.model_path,
            "max_concurrent_sessions": settings.session.max_concurrent,
        },
    )
