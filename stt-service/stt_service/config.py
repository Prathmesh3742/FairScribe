"""
FairScribe STT Service — Configuration

Pydantic-based settings loaded from config.yaml and overridable via
environment variables prefixed with FAIRSCRIBE_STT_.

Example override:
    FAIRSCRIBE_STT_PORT=5401 python run.py
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Base directory — all relative paths resolve from stt-service/
# ---------------------------------------------------------------------------

SERVICE_DIR = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# Nested config models
# ---------------------------------------------------------------------------

class AudioConfig(BaseModel):
    """Audio capture and processing parameters."""
    sample_rate: int = Field(16000, description="Sample rate in Hz")
    channels: int = Field(1, description="Audio channels (mono)")
    chunk_duration_ms: int = Field(30, description="Chunk duration for VAD frames")
    max_recording_seconds: int = Field(600, description="Max recording time per session")


class VADConfig(BaseModel):
    """Voice Activity Detection settings — tuned for exam room microphones."""
    enabled: bool = Field(True, description="Enable VAD filtering")
    threshold: float = Field(
        0.4, ge=0.0, le=1.0,
        description="Speech probability threshold. Lower = more sensitive (captures softer speech). "
                    "0.4 works well for standard exam microphones with moderate background noise."
    )
    min_speech_duration_ms: int = Field(
        300,
        description="Minimum speech segment length. Shorter bursts are treated as noise. "
                    "300ms avoids picking up short coughs or key clicks as speech."
    )
    min_silence_duration_ms: int = Field(
        400,
        description="Silence duration to end an utterance. Longer = fewer split utterances. "
                    "400ms gives Vosk time to produce a clean final result per sentence."
    )
    speech_pad_ms: int = Field(
        60, description="Padding around speech segments for context"
    )
    model_path: str = Field(
        "models/silero_vad.onnx",
        description="Path to Silero VAD ONNX model"
    )


class VoskConfig(BaseModel):
    """Vosk streaming speech recognition settings."""
    model_path: str = Field(
        "models/vosk-model-small-en-in-0.4",
        description="Path to Vosk model directory"
    )


class WhisperConfig(BaseModel):
    """Faster-Whisper verification settings."""
    enabled: bool = Field(True, description="Enable Whisper verification pass")
    model_size: str = Field("small.en", description="Whisper model size")
    device: str = Field("cpu", description="Inference device: cpu or cuda")
    compute_type: str = Field("int8", description="Compute type for CTranslate2")
    beam_size: int = Field(5, ge=1, description="Beam search width")
    model_path: str = Field(
        "models/whisper",
        description="Path to CTranslate2 converted model"
    )
    language: str = Field("en", description="Target language")


class SessionConfig(BaseModel):
    """Session management settings."""
    max_concurrent: int = Field(1, ge=1, description="Max concurrent sessions")
    idle_timeout_seconds: int = Field(300, ge=30, description="Idle session cleanup timeout")
    audio_buffer_max_mb: int = Field(50, ge=10, description="Max audio buffer per session in MB")


class LoggingConfig(BaseModel):
    """Logging configuration."""
    level: str = Field("INFO", description="Log level")
    format: str = Field(
        "%(asctime)s | %(levelname)-8s | %(name)-24s | %(message)s",
        description="Log format string"
    )
    file: Optional[str] = Field(None, description="Log file path (None = stdout only)")


# ---------------------------------------------------------------------------
# Root settings
# ---------------------------------------------------------------------------

class STTSettings(BaseModel):
    """Root configuration for the FairScribe STT Service."""
    host: str = Field("127.0.0.1", description="Server bind address")
    port: int = Field(5400, ge=1024, le=65535, description="Server port")
    audio: AudioConfig = Field(default_factory=AudioConfig)
    vad: VADConfig = Field(default_factory=VADConfig)
    vosk: VoskConfig = Field(default_factory=VoskConfig)
    whisper: WhisperConfig = Field(default_factory=WhisperConfig)
    session: SessionConfig = Field(default_factory=SessionConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)

    def resolve_path(self, relative_path: str) -> Path:
        """Resolve a relative path against the service directory."""
        p = Path(relative_path)
        if p.is_absolute():
            return p
        return SERVICE_DIR / p

    @property
    def vad_model_path(self) -> Path:
        return self.resolve_path(self.vad.model_path)

    @property
    def vosk_model_path(self) -> Path:
        return self.resolve_path(self.vosk.model_path)

    @property
    def whisper_model_path(self) -> Path:
        return self.resolve_path(self.whisper.model_path)

    @property
    def custom_vocabulary_path(self) -> Path:
        return self.resolve_path("custom_vocabulary.txt")

    def load_custom_vocabulary(self) -> str:
        """Load custom vocabulary terms as a comma-separated string."""
        vocab_path = self.custom_vocabulary_path
        if not vocab_path.exists():
            return ""
        try:
            with open(vocab_path, "r", encoding="utf-8") as f:
                # Read lines, strip whitespace, ignore empty lines and comments
                words = [
                    line.strip() for line in f
                    if line.strip() and not line.strip().startswith("#")
                ]
            return ", ".join(words)
        except Exception as e:
            logger.error("Failed to load custom vocabulary from %s: %s", vocab_path, e)
            return ""


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

def load_settings(config_path: Optional[str] = None) -> STTSettings:
    """
    Load settings from config.yaml, then overlay environment variable overrides.

    Resolution order:
        1. Defaults (from Pydantic models above)
        2. config.yaml values
        3. Environment variables (FAIRSCRIBE_STT_* prefix)

    Args:
        config_path: Explicit path to config.yaml. If None, looks for
                     config.yaml in the stt-service/ directory.

    Returns:
        Fully resolved STTSettings instance.
    """
    if config_path is None:
        config_path = str(SERVICE_DIR / "config.yaml")

    data: dict = {}
    config_file = Path(config_path)

    if config_file.exists():
        logger.info("Loading config from %s", config_file)
        with open(config_file, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)
            if isinstance(raw, dict):
                data = raw
    else:
        logger.warning(
            "Config file not found at %s — using defaults", config_file
        )

    # Environment variable overrides for top-level scalar fields
    env_prefix = "FAIRSCRIBE_STT_"
    for key in ("host", "port"):
        env_key = f"{env_prefix}{key.upper()}"
        env_val = os.environ.get(env_key)
        if env_val is not None:
            if key == "port":
                data[key] = int(env_val)
            else:
                data[key] = env_val

    return STTSettings(**data)


# ---------------------------------------------------------------------------
# Configure Python logging
# ---------------------------------------------------------------------------

def setup_logging(config: LoggingConfig) -> None:
    """Configure the root logger based on settings."""
    handlers: list[logging.Handler] = [logging.StreamHandler()]

    if config.file:
        log_dir = Path(config.file).parent
        log_dir.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(config.file, encoding="utf-8"))

    logging.basicConfig(
        level=getattr(logging, config.level.upper(), logging.INFO),
        format=config.format,
        handlers=handlers,
        force=True,  # Override any existing root logger config
    )
