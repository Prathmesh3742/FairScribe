"""
FairScribe STT Service — FastAPI Application Factory

Creates and configures the FastAPI application with:
    - Route registration (health, sessions, streaming)
    - Engine initialization on startup
    - Graceful shutdown
    - Background task for session cleanup
    - CORS configuration for Electron

The application is designed to be launched by the Electron main process
as a child process, communicating via HTTP REST + WebSocket on localhost.
"""

from __future__ import annotations

import asyncio
import logging

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import load_settings, setup_logging, STTSettings
from .session.manager import SessionManager
from .routes import health, sessions, streaming
from . import __version__

logger = logging.getLogger(__name__)


def create_app(settings: STTSettings | None = None) -> FastAPI:
    """
    Create and configure the FastAPI application.

    Args:
        settings: Optional pre-loaded settings. If None, settings are
                  loaded from config.yaml.

    Returns:
        Configured FastAPI application instance.
    """
    if settings is None:
        settings = load_settings()

    # Configure logging
    setup_logging(settings.logging)

    app = FastAPI(
        title="FairScribe STT Service",
        description=(
            "Offline Speech-to-Text backend for the FairScribe examination terminal. "
            "Provides real-time streaming recognition (Vosk), voice activity detection "
            "(Silero VAD), and post-recording verification (Faster-Whisper). "
            "Completely offline — no cloud APIs, no internet required."
        ),
        version=__version__,
        docs_url="/docs",      # Swagger UI (dev only — disable in production)
        redoc_url="/redoc",    # ReDoc (dev only)
    )

    # Store settings and session manager on app state for route access
    app.state.settings = settings
    app.state.session_manager = SessionManager(settings)

    # ── CORS ──
    # Allow the Electron renderer (localhost) to reach the API.
    # In production, restrict to only the specific Electron origin.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",       # Vite dev server
            "http://localhost:5400",       # Self
            "file://",                     # Electron production (file:// protocol)
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Register routes ──
    app.include_router(health.router)
    app.include_router(sessions.router)
    app.include_router(streaming.router)

    # ── Startup event ──
    @app.on_event("startup")
    async def on_startup() -> None:
        logger.info("=" * 60)
        logger.info("FairScribe STT Service v%s starting", __version__)
        logger.info("=" * 60)
        logger.info("Host: %s:%d", settings.host, settings.port)
        logger.info("Vosk model: %s", settings.vosk.model_path)
        logger.info("Whisper: %s (enabled=%s)", settings.whisper.model_size, settings.whisper.enabled)
        logger.info("VAD: threshold=%.2f (enabled=%s)", settings.vad.threshold, settings.vad.enabled)

        # Load engines (non-blocking — failures are logged, not fatal)
        manager: SessionManager = app.state.session_manager
        results = await manager.load_engines()

        # Summary
        loaded = sum(1 for v in results.values() if v)
        total = len(results)
        logger.info(
            "Engine loading complete: %d/%d loaded successfully", loaded, total
        )

        if not results.get("vosk", False):
            logger.warning(
                "⚠️  Vosk engine NOT loaded — real-time streaming recognition "
                "will not work. Download a model and update config.yaml."
            )

        # Start session cleanup background task
        app.state.cleanup_task = asyncio.create_task(
            _session_cleanup_loop(app)
        )

        logger.info("STT Service ready — listening on http://%s:%d", settings.host, settings.port)

    # ── Shutdown event ──
    @app.on_event("shutdown")
    async def on_shutdown() -> None:
        logger.info("STT Service shutting down...")

        # Cancel cleanup task
        cleanup_task = getattr(app.state, "cleanup_task", None)
        if cleanup_task and not cleanup_task.done():
            cleanup_task.cancel()
            try:
                await cleanup_task
            except asyncio.CancelledError:
                pass

        # Graceful engine shutdown
        manager: SessionManager = app.state.session_manager
        await manager.shutdown()

        logger.info("STT Service stopped")

    return app


async def _session_cleanup_loop(app: FastAPI) -> None:
    """
    Background task that periodically cleans up expired sessions.

    Runs every 60 seconds. Sessions that have been idle longer than
    the configured timeout are transitioned to EXPIRED and their
    audio buffers are freed.
    """
    manager: SessionManager = app.state.session_manager

    while True:
        try:
            await asyncio.sleep(60)
            await manager.cleanup_expired_sessions()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Session cleanup error: %s", e, exc_info=True)


def main() -> None:
    """
    Entry point for the STT service.

    Loads config, creates the FastAPI app, and runs uvicorn.
    Called by run.py or the console_scripts entry point.
    """
    settings = load_settings()
    setup_logging(settings.logging)

    app = create_app(settings)

    logger.info(
        "Starting uvicorn server on %s:%d", settings.host, settings.port
    )

    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.logging.level.lower(),
        # Disable uvicorn's default access log (we have our own logging)
        access_log=False,
        # Single worker — exam terminal is single-user
        workers=1,
    )
