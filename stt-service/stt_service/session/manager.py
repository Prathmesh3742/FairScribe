"""
FairScribe STT Service — Session Manager

Orchestrates the lifecycle of STT sessions, coordinating between:
    - Session state machine (session/state.py)
    - VAD engine (engine/vad.py)
    - Vosk streaming engine (engine/vosk_engine.py)
    - Whisper verification engine (engine/whisper_engine.py)
    - Audio processor (engine/audio_processor.py)

The SessionManager is the primary interface used by the API routes.
It is a singleton held by the FastAPI app instance.

Design for Electron integration:
    The Electron main process will call these methods via HTTP/WebSocket.
    The API contract (models.py) is designed to map cleanly to Electron
    IPC channels (stt:startSession, stt:sendAudio, stt:stopRecording, etc.).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from ..config import STTSettings
from ..engine.audio_processor import AudioProcessor
from ..engine.vad import VADEngine
from ..engine.vosk_engine import VoskEngine
from ..engine.whisper_engine import WhisperEngine
from ..models import (
    SessionStatus,
    SessionInfo,
    StreamingResult,
    VerificationResult,
)
from .state import SessionState

logger = logging.getLogger(__name__)


class SessionManager:
    """
    Manages STT session lifecycles and engine coordination.

    Thread safety: the manager uses asyncio primitives. All engine
    operations that may block are run in an executor to avoid blocking
    the event loop.
    """

    def __init__(self, settings: STTSettings):
        self.settings = settings

        # Engines (lazy-loaded)
        self.audio_processor = AudioProcessor(
            sample_rate=settings.audio.sample_rate,
            channels=settings.audio.channels,
        )
        self.vad_engine = VADEngine(
            model_path=str(settings.vad_model_path),
            threshold=settings.vad.threshold,
            sample_rate=settings.audio.sample_rate,
        )
        self.vosk_engine = VoskEngine(
            model_path=str(settings.vosk_model_path),
            sample_rate=settings.audio.sample_rate,
        )
        self.whisper_engine = WhisperEngine(
            model_size=settings.whisper.model_size,
            device=settings.whisper.device,
            compute_type=settings.whisper.compute_type,
            beam_size=settings.whisper.beam_size,
            model_path=str(settings.whisper_model_path),
            language=settings.whisper.language,
        )

        # Active sessions
        self._sessions: dict[str, SessionState] = {}
        self._max_concurrent = settings.session.max_concurrent

        # Engine load status
        self._engines_loaded = False

    # ---------------------------------------------------------------------------
    # Engine lifecycle
    # ---------------------------------------------------------------------------

    async def load_engines(self) -> dict[str, bool]:
        """
        Load all engine models. Called once at service startup.

        Returns a dict mapping engine name to load success status.
        Models that fail to load are logged but do not prevent the
        service from starting — the service runs in degraded mode.
        """
        loop = asyncio.get_event_loop()
        results: dict[str, bool] = {}

        # VAD
        if self.settings.vad.enabled:
            results["vad"] = await loop.run_in_executor(
                None, self.vad_engine.load
            )
        else:
            results["vad"] = False
            logger.info("VAD disabled in config — skipping load")

        # Vosk
        results["vosk"] = await loop.run_in_executor(
            None, self.vosk_engine.load
        )

        # Whisper
        if self.settings.whisper.enabled:
            results["whisper"] = await loop.run_in_executor(
                None, self.whisper_engine.load
            )
        else:
            results["whisper"] = False
            logger.info("Whisper disabled in config — skipping load")

        self._engines_loaded = True

        # Log summary
        for name, loaded in results.items():
            status = "✓ loaded" if loaded else "✗ NOT loaded"
            logger.info("Engine %s: %s", name, status)

        return results

    async def unload_engines(self) -> None:
        """Unload all engines and free memory."""
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self.vad_engine.unload)
        await loop.run_in_executor(None, self.vosk_engine.unload)
        await loop.run_in_executor(None, self.whisper_engine.unload)
        self._engines_loaded = False
        logger.info("All engines unloaded")

    def get_engine_health(self) -> dict:
        """Return engine health status for the health endpoint."""
        from ..models import EngineHealth, EngineStatus

        return {
            "vad": EngineHealth(
                status=EngineStatus.READY if self.vad_engine.is_loaded else EngineStatus.NOT_LOADED,
                model_path=str(self.settings.vad_model_path),
                model_loaded=self.vad_engine.is_loaded,
            ),
            "vosk": EngineHealth(
                status=EngineStatus.READY if self.vosk_engine.is_loaded else EngineStatus.NOT_LOADED,
                model_path=str(self.settings.vosk_model_path),
                model_loaded=self.vosk_engine.is_loaded,
            ),
            "whisper": EngineHealth(
                status=EngineStatus.READY if self.whisper_engine.is_loaded else EngineStatus.NOT_LOADED,
                model_path=str(self.settings.whisper_model_path),
                model_loaded=self.whisper_engine.is_loaded,
            ),
        }

    # ---------------------------------------------------------------------------
    # Session CRUD
    # ---------------------------------------------------------------------------

    def create_session(
        self,
        student_id: str,
        exam_id: str,
        question_id: str,
        language: str = "en",
    ) -> SessionState:
        """
        Create a new STT session.

        Raises ValueError if the max concurrent session limit is reached.
        """
        # Cleanup orphaned/stale sessions for this student/question to prevent concurrent limit errors
        for sid, s in list(self._sessions.items()):
            if s.student_id == student_id and s.question_id == question_id and s.status in (SessionStatus.CREATED, SessionStatus.LISTENING, SessionStatus.PROCESSING):
                logger.warning("Cleaning up stale session %s for student %s, question %s", sid[:8], student_id, question_id)
                self.delete_session(sid)
            elif s.student_id == student_id and s.status == SessionStatus.CREATED:
                logger.warning("Cleaning up abandoned CREATED session %s for student %s", sid[:8], student_id)
                self.delete_session(sid)

        # Check concurrent limit
        active_count = sum(
            1 for s in self._sessions.values()
            if s.status in (SessionStatus.CREATED, SessionStatus.LISTENING)
        )
        if active_count >= self._max_concurrent:
            raise ValueError(
                f"Max concurrent sessions ({self._max_concurrent}) reached. "
                "Close an existing session first."
            )

        buffer_max = self.settings.session.audio_buffer_max_mb * 1024 * 1024
        session = SessionState(
            student_id=student_id,
            exam_id=exam_id,
            question_id=question_id,
            language=language,
            buffer_max_bytes=buffer_max,
        )

        self._sessions[session.session_id] = session
        logger.info(
            "Session created: %s (student=%s, question=%s)",
            session.session_id[:8], student_id, question_id,
        )
        return session

    def get_session(self, session_id: str) -> Optional[SessionState]:
        """Get a session by ID. Returns None if not found."""
        return self._sessions.get(session_id)

    def list_sessions(self) -> list[SessionState]:
        """List all sessions."""
        return list(self._sessions.values())

    def delete_session(self, session_id: str) -> bool:
        """
        Delete a session and free its resources.

        Returns True if the session existed and was deleted.
        """
        session = self._sessions.pop(session_id, None)
        if session is None:
            return False

        session.vosk_recogniser = None
        session.clear_audio()
        logger.info("Session deleted: %s", session_id[:8])
        return True

    @property
    def active_session_count(self) -> int:
        return sum(
            1 for s in self._sessions.values()
            if s.status in (SessionStatus.CREATED, SessionStatus.LISTENING, SessionStatus.PROCESSING)
        )

    # ---------------------------------------------------------------------------
    # Streaming: start listening
    # ---------------------------------------------------------------------------

    async def start_listening(self, session_id: str) -> bool:
        """
        Transition a session to LISTENING state and prepare the Vosk recogniser.

        Called when the WebSocket connection is established.
        """
        session = self.get_session(session_id)
        if session is None:
            logger.error("Session not found: %s", session_id[:8])
            return False

        if not session.transition_to(SessionStatus.LISTENING):
            return False

        # Create a fresh Vosk recogniser for this session
        if self.vosk_engine.is_loaded:
            loop = asyncio.get_event_loop()
            recogniser = await loop.run_in_executor(
                None, self.vosk_engine.create_recogniser
            )
            session.vosk_recogniser = recogniser

        # Reset VAD state for fresh recording
        if self.vad_engine.is_loaded:
            self.vad_engine.reset()

        return True

    # ---------------------------------------------------------------------------
    # Streaming: process audio chunk
    # ---------------------------------------------------------------------------

    async def process_audio_chunk(
        self,
        session_id: str,
        audio_bytes: bytes,
    ) -> Optional[StreamingResult]:
        """
        Process an incoming audio chunk: VAD → buffer → Vosk.

        Called for each audio chunk received over the WebSocket.

        Args:
            session_id: Session to process for.
            audio_bytes: Raw 16-bit PCM bytes (mono, 16 kHz).

        Returns:
            A StreamingResult with partial or final text, or None on error.
        """
        session = self.get_session(session_id)
        if session is None or session.status != SessionStatus.LISTENING:
            return None

        loop = asyncio.get_event_loop()

        # 1. VAD check
        is_speech = True
        if self.vad_engine.is_loaded and self.settings.vad.enabled:
            vad_results = await loop.run_in_executor(
                None, self.vad_engine.process_chunk, audio_bytes
            )
            # Consider the chunk as speech if ANY frame is speech
            is_speech = any(r["is_speech"] for r in vad_results) if vad_results else True

        # 2. Buffer the audio (regardless of VAD — needed for Whisper verification)
        session.append_audio(audio_bytes)

        # 3. Feed to Vosk (only if speech detected)
        result_data = {"type": "partial", "text": "", "confidence": 0.0, "words": []}

        if is_speech and session.vosk_recogniser is not None and self.vosk_engine.is_loaded:
            result_data = await loop.run_in_executor(
                None,
                self.vosk_engine.process_chunk,
                session.vosk_recogniser,
                audio_bytes,
            )

            # Update session transcript
            if result_data["type"] == "final":
                session.append_vosk_final(result_data["text"], result_data["confidence"])
            else:
                session.update_vosk_partial(result_data["text"])

        # 4. Build response
        timestamp_ms = session.audio_duration_seconds * 1000

        return StreamingResult(
            session_id=session_id,
            type=result_data["type"],
            text=result_data["text"],
            confidence=result_data["confidence"],
            is_speech=is_speech,
            timestamp_ms=timestamp_ms,
        )

    # ---------------------------------------------------------------------------
    # Stop recording + Whisper verification
    # ---------------------------------------------------------------------------

    async def stop_recording(
        self,
        session_id: str,
        run_whisper: bool = True,
    ) -> Optional[VerificationResult]:
        """
        Stop recording, finalise Vosk, and optionally run Whisper verification.

        This is called when the candidate clicks "Stop Dictation" or when
        a voice command triggers recording stop.

        Args:
            session_id: Session to stop.
            run_whisper: Whether to run Whisper verification.

        Returns:
            VerificationResult with both Vosk and Whisper transcripts.
        """
        session = self.get_session(session_id)
        if session is None:
            logger.error("Session not found: %s", session_id[:8])
            return None

        if not session.transition_to(SessionStatus.PROCESSING):
            return None

        loop = asyncio.get_event_loop()
        start_time = time.monotonic()

        # 1. Finalise Vosk (flush remaining audio in the recogniser buffer)
        if session.vosk_recogniser is not None and self.vosk_engine.is_loaded:
            final_result = await loop.run_in_executor(
                None,
                self.vosk_engine.finalise,
                session.vosk_recogniser,
            )
            if final_result["text"]:
                session.append_vosk_final(final_result["text"], final_result["confidence"])

        vosk_transcript = session.vosk_transcript
        avg_vosk_confidence = session.average_vosk_confidence
        logger.info("Vosk overall confidence: %.2f", avg_vosk_confidence)

        # 2. Whisper verification (if enabled, model loaded, and required)
        whisper_transcript = ""
        whisper_confidence = 0.0
        whisper_available = False

        # CONFIDENCE-BASED PROCESSING:
        # If Vosk's confidence is exceptionally high (> 0.92), we can safely skip Whisper.
        # This saves significant CPU time and battery on laptops.
        needs_whisper = run_whisper and avg_vosk_confidence <= 0.92

        if (
            needs_whisper
            and self.settings.whisper.enabled
            and self.whisper_engine.is_loaded
            and session.audio_size_bytes > 0
        ):
            audio_bytes = session.audio_bytes
            
            # Load custom vocabulary from config
            custom_vocabulary = self.settings.load_custom_vocabulary()

            whisper_result = await loop.run_in_executor(
                None,
                self.whisper_engine.transcribe,
                audio_bytes,
                self.settings.audio.sample_rate,
                vosk_transcript,       # Guide Whisper to prevent paraphrasing
                custom_vocabulary,     # Bias toward technical/academic terms
            )

            whisper_transcript = whisper_result["text"]
            whisper_confidence = whisper_result["confidence"]
            whisper_available = True

            session.set_whisper_result(whisper_transcript, whisper_confidence)

            logger.info(
                "Whisper verification: %.1fs audio → '%.50s...' (conf=%.2f)",
                whisper_result.get("audio_duration_seconds", 0),
                whisper_transcript[:50],
                whisper_confidence,
            )
        elif run_whisper and avg_vosk_confidence > 0.92:
            logger.info("Skipping Whisper: Vosk confidence %.2f is very high", avg_vosk_confidence)

        # 3. Determine final transcript
        final_transcript = whisper_transcript if whisper_available and whisper_transcript else vosk_transcript

        # 4. Transition to COMPLETED
        session.transition_to(SessionStatus.COMPLETED)

        processing_time = time.monotonic() - start_time

        return VerificationResult(
            session_id=session_id,
            vosk_transcript=vosk_transcript,
            whisper_transcript=whisper_transcript,
            final_transcript=final_transcript,
            whisper_available=whisper_available,
            whisper_confidence=whisper_confidence,
            audio_duration_seconds=session.audio_duration_seconds,
            processing_time_seconds=processing_time,
            status=SessionStatus.COMPLETED,
        )

    # ---------------------------------------------------------------------------
    # Cleanup
    # ---------------------------------------------------------------------------

    async def cleanup_expired_sessions(self) -> int:
        """
        Clean up sessions that have been idle longer than the configured timeout.

        Called periodically by a background task.

        Returns the number of sessions cleaned up.
        """
        timeout = self.settings.session.idle_timeout_seconds
        now = time.time()
        expired_ids = []

        for session_id, session in self._sessions.items():
            idle_seconds = now - session.updated_at.timestamp()
            if idle_seconds > timeout and session.status not in (
                SessionStatus.COMPLETED,
                SessionStatus.EXPIRED,
            ):
                expired_ids.append(session_id)

        for session_id in expired_ids:
            session = self._sessions.get(session_id)
            if session:
                session.transition_to(SessionStatus.EXPIRED)
                session.clear_audio()
                session.vosk_recogniser = None

        if expired_ids:
            logger.info("Cleaned up %d expired session(s)", len(expired_ids))

        return len(expired_ids)

    async def shutdown(self) -> None:
        """Graceful shutdown: clean up all sessions and unload engines."""
        # Clear all sessions
        for session_id in list(self._sessions.keys()):
            self.delete_session(session_id)

        # Unload engines
        await self.unload_engines()
        logger.info("SessionManager shut down")
