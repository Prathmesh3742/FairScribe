"""
FairScribe STT Service — Session State Machine & Audio Buffer

Each STT session tracks:
    - Lifecycle state (created → listening → processing → completed)
    - Accumulated audio buffer (raw PCM)
    - Vosk streaming transcript (built incrementally)
    - Timestamps and metadata

The audio buffer is a simple append-only byte buffer. For a single
exam session (max 10 minutes per answer), this is well within the
50 MB cap configured in config.yaml.

Design principle: the session state is the single source of truth.
All mutations go through explicit transition methods.
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

from ..models import SessionStatus

logger = logging.getLogger(__name__)

# Audio buffer cap: 50 MB default (configurable via SessionConfig)
DEFAULT_BUFFER_MAX_BYTES = 50 * 1024 * 1024


class SessionState:
    """
    State container for a single STT session.

    Lifecycle:
        CREATED → LISTENING → PROCESSING → COMPLETED
                                         → ERROR
        Any state → EXPIRED (timeout cleanup)
    """

    def __init__(
        self,
        student_id: str,
        exam_id: str,
        question_id: str,
        language: str = "en",
        buffer_max_bytes: int = DEFAULT_BUFFER_MAX_BYTES,
    ):
        self.session_id: str = str(uuid.uuid4())
        self.student_id: str = student_id
        self.exam_id: str = exam_id
        self.question_id: str = question_id
        self.language: str = language

        # State
        self._status: SessionStatus = SessionStatus.CREATED
        self.created_at: datetime = datetime.now(timezone.utc)
        self.updated_at: datetime = self.created_at
        self.error_message: Optional[str] = None

        # Audio buffer
        self._audio_buffer: bytearray = bytearray()
        self._buffer_max_bytes: int = buffer_max_bytes
        self._audio_duration_seconds: float = 0.0
        self._sample_rate: int = 16000

        # Vosk streaming transcript (accumulated from finals)
        self._vosk_finals: list[str] = []
        self._vosk_confidences: list[float] = []
        self._vosk_partial: str = ""

        # Whisper verification result
        self._whisper_transcript: str = ""
        self._whisper_confidence: float = 0.0

        # Vosk recogniser reference (managed by SessionManager)
        self.vosk_recogniser: Optional[object] = None

        logger.debug(
            "Session created: id=%s, student=%s, question=%s",
            self.session_id, self.student_id, self.question_id,
        )

    # ---------------------------------------------------------------------------
    # Properties
    # ---------------------------------------------------------------------------

    @property
    def status(self) -> SessionStatus:
        return self._status

    @property
    def audio_bytes(self) -> bytes:
        """Return the accumulated audio buffer as immutable bytes."""
        return bytes(self._audio_buffer)

    @property
    def audio_size_bytes(self) -> int:
        return len(self._audio_buffer)

    @property
    def audio_duration_seconds(self) -> float:
        """Audio duration based on buffer size and sample rate."""
        # 16-bit mono = 2 bytes per sample
        num_samples = len(self._audio_buffer) // 2
        return num_samples / self._sample_rate if self._sample_rate > 0 else 0.0

    @property
    def vosk_transcript(self) -> str:
        """Combined Vosk transcript from all final results + current partial."""
        finals = " ".join(self._vosk_finals).strip()
        if self._vosk_partial:
            return f"{finals} {self._vosk_partial}".strip()
        return finals

    @property
    def whisper_transcript(self) -> str:
        return self._whisper_transcript

    @property
    def whisper_confidence(self) -> float:
        return self._whisper_confidence

    @property
    def final_transcript(self) -> str:
        """Best available transcript: Whisper if available, else Vosk."""
        if self._whisper_transcript:
            return self._whisper_transcript
        return self.vosk_transcript

    @property
    def is_buffer_full(self) -> bool:
        return len(self._audio_buffer) >= self._buffer_max_bytes

    # ---------------------------------------------------------------------------
    # State transitions
    # ---------------------------------------------------------------------------

    def transition_to(self, new_status: SessionStatus) -> bool:
        """
        Attempt a state transition. Returns True if valid, False otherwise.

        Valid transitions:
            CREATED    → LISTENING
            LISTENING  → PROCESSING, ERROR
            PROCESSING → COMPLETED, ERROR
            Any        → EXPIRED
        """
        valid_transitions: dict[SessionStatus, set[SessionStatus]] = {
            SessionStatus.CREATED:    {SessionStatus.LISTENING, SessionStatus.EXPIRED},
            SessionStatus.LISTENING:  {SessionStatus.PROCESSING, SessionStatus.ERROR, SessionStatus.EXPIRED},
            SessionStatus.PROCESSING: {SessionStatus.COMPLETED, SessionStatus.ERROR, SessionStatus.EXPIRED},
            SessionStatus.COMPLETED:  {SessionStatus.EXPIRED},
            SessionStatus.ERROR:      {SessionStatus.EXPIRED},
        }

        allowed = valid_transitions.get(self._status, set())
        if new_status not in allowed:
            logger.warning(
                "Invalid state transition: %s → %s (session=%s)",
                self._status.value, new_status.value, self.session_id,
            )
            return False

        old_status = self._status
        self._status = new_status
        self.updated_at = datetime.now(timezone.utc)

        logger.info(
            "Session %s: %s → %s",
            self.session_id[:8], old_status.value, new_status.value,
        )
        return True

    def set_error(self, message: str) -> None:
        """Transition to ERROR state with an error message."""
        self.error_message = message
        self.transition_to(SessionStatus.ERROR)

    # ---------------------------------------------------------------------------
    # Audio buffer
    # ---------------------------------------------------------------------------

    def append_audio(self, chunk: bytes) -> bool:
        """
        Append audio to the session buffer.

        Args:
            chunk: Raw 16-bit PCM bytes.

        Returns:
            True if accepted, False if buffer is full.
        """
        if self._status != SessionStatus.LISTENING:
            logger.warning(
                "Cannot append audio in state %s (session=%s)",
                self._status.value, self.session_id[:8],
            )
            return False

        if len(self._audio_buffer) + len(chunk) > self._buffer_max_bytes:
            logger.warning(
                "Audio buffer full: %d bytes (max=%d) — session=%s",
                len(self._audio_buffer), self._buffer_max_bytes, self.session_id[:8],
            )
            return False

        self._audio_buffer.extend(chunk)
        self.updated_at = datetime.now(timezone.utc)
        return True

    def clear_audio(self) -> None:
        """Clear the audio buffer (e.g., after Whisper processing)."""
        self._audio_buffer.clear()

    # ---------------------------------------------------------------------------
    # Transcript updates
    # ---------------------------------------------------------------------------

    def update_vosk_partial(self, text: str) -> None:
        """Update the current Vosk partial result."""
        self._vosk_partial = text
        self.updated_at = datetime.now(timezone.utc)

    def append_vosk_final(self, text: str, confidence: float = 0.0) -> None:
        """Append a Vosk final result and clear the partial."""
        if text.strip():
            self._vosk_finals.append(text.strip())
            self._vosk_confidences.append(confidence)
        self._vosk_partial = ""
        self.updated_at = datetime.now(timezone.utc)

    @property
    def average_vosk_confidence(self) -> float:
        """Average confidence across all Vosk final utterances."""
        if not self._vosk_confidences:
            return 0.0
        return sum(self._vosk_confidences) / len(self._vosk_confidences)

    def set_whisper_result(self, transcript: str, confidence: float) -> None:
        """Store the Whisper verification result."""
        self._whisper_transcript = transcript
        self._whisper_confidence = confidence
        self.updated_at = datetime.now(timezone.utc)

    # ---------------------------------------------------------------------------
    # Serialisation
    # ---------------------------------------------------------------------------

    def to_info_dict(self) -> dict:
        """Return a dict suitable for the SessionInfo response model."""
        return {
            "session_id": self.session_id,
            "status": self._status,
            "student_id": self.student_id,
            "exam_id": self.exam_id,
            "question_id": self.question_id,
            "language": self.language,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "audio_duration_seconds": self.audio_duration_seconds,
            "vosk_transcript": self.vosk_transcript,
        }
