"""
FairScribe STT Service — Session Management Routes

POST   /api/sessions              — Create a new STT session
GET    /api/sessions              — List all sessions
GET    /api/sessions/{session_id} — Get session details
DELETE /api/sessions/{session_id} — Delete a session
POST   /api/sessions/{session_id}/stop — Stop recording + Whisper verification

These REST endpoints manage session lifecycle. Audio streaming happens
over WebSocket (see streaming.py).

Electron IPC mapping:
    POST /api/sessions        → ipcMain.handle('stt:startSession')
    POST .../stop             → ipcMain.handle('stt:stopRecording')
    DELETE /api/sessions/{id} → ipcMain.handle('stt:deleteSession')
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, status

from ..models import (
    CreateSessionRequest,
    SessionInfo,
    SessionListResponse,
    StopRecordingRequest,
    VerificationResult,
    ErrorResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


# ---------------------------------------------------------------------------
# POST /api/sessions — Create session
# ---------------------------------------------------------------------------

@router.post(
    "",
    response_model=SessionInfo,
    status_code=status.HTTP_201_CREATED,
    responses={
        409: {"model": ErrorResponse, "description": "Max concurrent sessions reached"},
        503: {"model": ErrorResponse, "description": "Vosk engine not loaded"},
    },
)
async def create_session(
    body: CreateSessionRequest,
    request: Request,
) -> SessionInfo:
    """
    Create a new STT session for a student/question pair.

    The session starts in CREATED state. Audio streaming begins when
    the client connects to the WebSocket endpoint.

    The Electron main process should call this before opening the
    WebSocket connection.
    """
    manager = request.app.state.session_manager

    # Warn (but don't block) if Vosk is not loaded
    if not manager.vosk_engine.is_loaded:
        logger.warning(
            "Creating session with Vosk unavailable — streaming recognition disabled"
        )

    try:
        session = manager.create_session(
            student_id=body.student_id,
            exam_id=body.exam_id,
            question_id=body.question_id,
            language=body.language,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        )

    return SessionInfo(**session.to_info_dict())


# ---------------------------------------------------------------------------
# GET /api/sessions — List sessions
# ---------------------------------------------------------------------------

@router.get("", response_model=SessionListResponse)
async def list_sessions(request: Request) -> SessionListResponse:
    """List all STT sessions (active and completed)."""
    manager = request.app.state.session_manager
    sessions = manager.list_sessions()
    return SessionListResponse(
        sessions=[SessionInfo(**s.to_info_dict()) for s in sessions],
        total=len(sessions),
    )


# ---------------------------------------------------------------------------
# GET /api/sessions/{session_id} — Get session details
# ---------------------------------------------------------------------------

@router.get(
    "/{session_id}",
    response_model=SessionInfo,
    responses={404: {"model": ErrorResponse}},
)
async def get_session(session_id: str, request: Request) -> SessionInfo:
    """Get details for a specific session."""
    manager = request.app.state.session_manager
    session = manager.get_session(session_id)

    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found",
        )

    return SessionInfo(**session.to_info_dict())


# ---------------------------------------------------------------------------
# DELETE /api/sessions/{session_id} — Delete session
# ---------------------------------------------------------------------------

@router.delete(
    "/{session_id}",
    status_code=status.HTTP_200_OK,
    responses={404: {"model": ErrorResponse}},
)
async def delete_session(session_id: str, request: Request) -> None:
    """
    Delete a session and free its resources.

    Safe to call on completed or errored sessions (cleanup).
    """
    manager = request.app.state.session_manager
    deleted = manager.delete_session(session_id)

    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found",
        )


# ---------------------------------------------------------------------------
# POST /api/sessions/{session_id}/stop — Stop recording + verification
# ---------------------------------------------------------------------------

@router.post(
    "/{session_id}/stop",
    response_model=VerificationResult,
    responses={
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse, "description": "Session not in LISTENING state"},
    },
)
async def stop_recording(
    session_id: str,
    body: StopRecordingRequest,
    request: Request,
) -> VerificationResult:
    """
    Stop recording, finalise Vosk, and run Whisper verification.

    This is called when the candidate stops dictating (button click or
    voice command). The response includes both the Vosk real-time
    transcript and the Whisper-verified transcript.

    Whisper verification can be disabled per-request by setting
    `run_whisper_verification: false`.

    The session transitions: LISTENING → PROCESSING → COMPLETED.
    """
    manager = request.app.state.session_manager
    session = manager.get_session(session_id)

    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found",
        )

    result = await manager.stop_recording(
        session_id=session_id,
        run_whisper=body.run_whisper_verification,
    )

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Session {session_id} is not in a valid state for stopping "
                   f"(current state: {session.status.value})",
        )

    return result
