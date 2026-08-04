"""
FairScribe STT Service — WebSocket Streaming Route

WS /api/sessions/{session_id}/stream

Handles real-time bidirectional audio streaming:
    Client → Server: raw 16-bit PCM audio bytes (binary frames)
    Server → Client: JSON recognition results (text frames)

Protocol:
    1. Client creates a session via POST /api/sessions.
    2. Client opens WebSocket to /api/sessions/{session_id}/stream.
    3. Server transitions session to LISTENING.
    4. Client sends binary audio frames (16-bit PCM, 16 kHz, mono).
    5. Server responds with JSON StreamingResult messages.
    6. Client closes WebSocket when done (or calls POST .../stop first).

Message format (server → client):
    {
        "session_id": "...",
        "type": "partial" | "final",
        "text": "recognised text",
        "confidence": 0.0-1.0,
        "is_speech": true | false,
        "timestamp_ms": 1234.5
    }

Error handling:
    - If the session doesn't exist → WebSocket close 4004
    - If the session is in wrong state → WebSocket close 4009
    - If audio processing fails → error message sent, connection kept alive
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..models import SessionStatus

logger = logging.getLogger(__name__)

router = APIRouter(tags=["streaming"])


@router.websocket("/api/sessions/{session_id}/stream")
async def audio_stream(websocket: WebSocket, session_id: str) -> None:
    """
    WebSocket endpoint for real-time audio streaming.

    Accepts binary frames of 16-bit PCM audio (16 kHz, mono) and
    returns JSON recognition results.
    """
    manager = websocket.app.state.session_manager

    # ── Validate session ──
    session = manager.get_session(session_id)
    if session is None:
        await websocket.close(code=4004, reason="Session not found")
        return

    if session.status != SessionStatus.CREATED:
        await websocket.close(
            code=4009,
            reason=f"Session in invalid state: {session.status.value}. "
                   f"Expected: created.",
        )
        return

    # ── Accept connection ──
    await websocket.accept()
    logger.info("WebSocket connected: session=%s", session_id[:8])

    # ── Transition to LISTENING ──
    success = await manager.start_listening(session_id)
    if not success:
        await websocket.send_json({
            "error": "Failed to start listening",
            "session_id": session_id,
        })
        await websocket.close(code=4009, reason="Failed to start listening")
        return

    # Send initial ready message
    await websocket.send_json({
        "session_id": session_id,
        "type": "status",
        "text": "",
        "status": "listening",
        "message": "Ready for audio input",
    })

    # ── Streaming loop ──
    try:
        while True:
            # Receive audio data (binary frame)
            data = await websocket.receive()

            if "bytes" in data and data["bytes"] is not None:
                audio_chunk = data["bytes"]

                # Process through VAD → Vosk pipeline
                result = await manager.process_audio_chunk(session_id, audio_chunk)

                if result is not None:
                    # Send recognition result as JSON
                    await websocket.send_json(result.model_dump())

            elif "text" in data and data["text"] is not None:
                # Handle text commands (future: voice commands)
                text_msg = data["text"]
                try:
                    command = json.loads(text_msg)
                    await _handle_text_command(websocket, manager, session_id, command)
                except json.JSONDecodeError:
                    logger.debug("Received non-JSON text: %s", text_msg[:100])

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected: session=%s", session_id[:8])

    except Exception as e:
        logger.error(
            "WebSocket error (session=%s): %s", session_id[:8], e,
            exc_info=True,
        )
        try:
            await websocket.send_json({
                "error": "internal_error",
                "detail": str(e),
                "session_id": session_id,
            })
        except Exception:
            pass  # Connection may already be closed

    finally:
        # If session is still LISTENING (WebSocket disconnected without explicit stop),
        # auto-stop the recording so transcript is preserved.
        session = manager.get_session(session_id)
        if session is not None and session.status == SessionStatus.LISTENING:
            logger.info(
                "Auto-stopping session %s (WebSocket disconnected)",
                session_id[:8],
            )
            await manager.stop_recording(session_id, run_whisper=False)


async def _handle_text_command(
    websocket: WebSocket,
    manager: object,
    session_id: str,
    command: dict,
) -> None:
    """
    Handle a text-based command received over the WebSocket.

    Currently supported commands:
        { "command": "ping" }  → responds with pong

    Future commands (Phase 4):
        { "command": "stop" }
        { "command": "reset" }
    """
    cmd = command.get("command", "")

    if cmd == "ping":
        await websocket.send_json({
            "session_id": session_id,
            "type": "pong",
            "text": "",
        })
    else:
        logger.debug("Unknown WebSocket command: %s", cmd)
        await websocket.send_json({
            "session_id": session_id,
            "type": "error",
            "text": f"Unknown command: {cmd}",
        })
