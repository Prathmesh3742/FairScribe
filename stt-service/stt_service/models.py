"""
FairScribe STT Service — Pydantic Models (API Request/Response Schemas)

These schemas define the JSON contract between the Python STT service and
the Electron main process. They will be consumed via HTTP REST and WebSocket.

Design principle: keep schemas stable so the Electron IPC bridge can be
implemented without requiring changes to the Python service.
"""

from __future__ import annotations

import enum
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class SessionStatus(str, enum.Enum):
    """Lifecycle states for an STT session."""
    CREATED = "created"           # Session allocated, not yet streaming
    LISTENING = "listening"       # WebSocket connected, receiving audio
    PROCESSING = "processing"     # Recording stopped, Whisper verification running
    COMPLETED = "completed"       # Final transcript available
    ERROR = "error"               # Unrecoverable error
    EXPIRED = "expired"           # Timed out / cleaned up


class EngineStatus(str, enum.Enum):
    """Health status for an engine component."""
    READY = "ready"
    NOT_LOADED = "not_loaded"
    LOADING = "loading"
    ERROR = "error"


# ---------------------------------------------------------------------------
# Health Check
# ---------------------------------------------------------------------------

class EngineHealth(BaseModel):
    """Health status for a single engine component."""
    status: EngineStatus = EngineStatus.NOT_LOADED
    model_path: Optional[str] = None
    model_loaded: bool = False
    error: Optional[str] = None


class HealthResponse(BaseModel):
    """Response from GET /api/health."""
    status: str = Field("ok", description="Overall service status")
    version: str = Field(..., description="Service version")
    uptime_seconds: float = Field(..., description="Seconds since service start")
    engines: dict[str, EngineHealth] = Field(
        default_factory=dict,
        description="Per-engine health status"
    )
    active_sessions: int = Field(0, description="Number of active sessions")
    config: dict[str, Any] = Field(
        default_factory=dict,
        description="Relevant config summary (non-sensitive)"
    )


# ---------------------------------------------------------------------------
# Session Management
# ---------------------------------------------------------------------------

class CreateSessionRequest(BaseModel):
    """Request body for POST /api/sessions."""
    student_id: str = Field(..., description="Student identifier from Electron")
    exam_id: str = Field(..., description="Exam identifier")
    question_id: str = Field(..., description="Current question being answered")
    language: str = Field("en", description="Recognition language (BCP-47)")


class SessionInfo(BaseModel):
    """Session metadata returned in API responses."""
    session_id: str = Field(..., description="Unique session identifier")
    status: SessionStatus = Field(..., description="Current session state")
    student_id: str
    exam_id: str
    question_id: str
    language: str = "en"
    created_at: datetime
    updated_at: datetime
    audio_duration_seconds: float = Field(
        0.0, description="Total audio received in seconds"
    )
    vosk_transcript: str = Field(
        "", description="Latest Vosk streaming transcript"
    )


class SessionListResponse(BaseModel):
    """Response from GET /api/sessions."""
    sessions: list[SessionInfo] = Field(default_factory=list)
    total: int = 0


# ---------------------------------------------------------------------------
# Streaming (WebSocket messages)
# ---------------------------------------------------------------------------

class StreamingResult(BaseModel):
    """
    A real-time recognition result sent from the server to the client
    over the WebSocket connection.

    The Electron main process will forward these to the renderer via IPC.
    """
    session_id: str
    type: str = Field(
        ...,
        description="Result type: 'partial' (interim) or 'final' (end of utterance)"
    )
    text: str = Field("", description="Recognized text")
    confidence: float = Field(
        0.0, ge=0.0, le=1.0,
        description="Recognition confidence (0.0–1.0); 0 for partials"
    )
    is_speech: bool = Field(
        True,
        description="Whether VAD detected speech in the current chunk"
    )
    timestamp_ms: float = Field(
        0.0, description="Audio timestamp in milliseconds"
    )


class VADEvent(BaseModel):
    """Voice activity detection state change event."""
    session_id: str
    type: str = "vad"  # Always "vad"
    is_speech: bool
    timestamp_ms: float = 0.0


# ---------------------------------------------------------------------------
# Stop / Verification
# ---------------------------------------------------------------------------

class StopRecordingRequest(BaseModel):
    """Request body for POST /api/sessions/{session_id}/stop."""
    run_whisper_verification: bool = Field(
        True,
        description="Whether to run Whisper verification after stopping"
    )


class VerificationResult(BaseModel):
    """
    Result of the Whisper verification pass.

    Returned by POST /api/sessions/{session_id}/stop after verification
    completes. If Whisper is disabled or unavailable, `whisper_available`
    is False and only the Vosk transcript is returned.
    """
    session_id: str
    vosk_transcript: str = Field("", description="Real-time Vosk transcript")
    whisper_transcript: str = Field("", description="Whisper-verified transcript")
    final_transcript: str = Field(
        "",
        description="Best available transcript (Whisper if available, else Vosk)"
    )
    whisper_available: bool = Field(
        False,
        description="Whether Whisper verification was performed"
    )
    whisper_confidence: float = Field(
        0.0, ge=0.0, le=1.0,
        description="Whisper confidence score"
    )
    audio_duration_seconds: float = 0.0
    processing_time_seconds: float = 0.0
    status: SessionStatus = SessionStatus.COMPLETED


# ---------------------------------------------------------------------------
# Error
# ---------------------------------------------------------------------------

class ErrorResponse(BaseModel):
    """Standard error response."""
    error: str = Field(..., description="Error type / code")
    detail: str = Field("", description="Human-readable description")
    session_id: Optional[str] = None
