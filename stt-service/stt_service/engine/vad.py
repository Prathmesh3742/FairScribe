"""
FairScribe STT Service — Voice Activity Detection (Silero VAD)

Wraps the Silero VAD ONNX model for frame-level speech/non-speech
classification. Used to filter silence before sending audio to Vosk,
reducing CPU load and improving recognition accuracy.

The Silero VAD model is ~2MB and runs in <1ms per frame on CPU.
It is loaded via ONNX Runtime (no PyTorch dependency required).

Model download:
    The ONNX model is auto-downloaded from GitHub on first use if
    the model file is not present at the configured path. See
    models/README.md for manual download instructions.
"""

from __future__ import annotations

import logging
import urllib.request
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# Silero VAD ONNX model URL (GitHub release asset)
SILERO_VAD_URL = (
    "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"
)

# VAD operates on fixed-size frames. Silero supports 30ms frames at 16kHz.
SUPPORTED_FRAME_MS = (30, 60, 100)
DEFAULT_FRAME_MS = 30


class VADEngine:
    """
    Silero Voice Activity Detection engine using ONNX Runtime.

    Usage:
        vad = VADEngine(model_path="models/silero_vad.onnx", threshold=0.5)
        vad.load()

        # For each audio frame (30ms of 16kHz mono float32):
        is_speech = vad.is_speech(audio_frame)

        # Reset state between recordings:
        vad.reset()
    """

    def __init__(
        self,
        model_path: str = "models/silero_vad.onnx",
        threshold: float = 0.5,
        sample_rate: int = 16000,
        frame_ms: int = DEFAULT_FRAME_MS,
    ):
        self.model_path = Path(model_path)
        self.threshold = threshold
        self.sample_rate = sample_rate
        self.frame_ms = frame_ms
        self._session: Optional[object] = None  # onnxruntime.InferenceSession
        self._loaded = False

        # Internal state tensors (Silero VAD is stateful — LSTM hidden states)
        self._h = None
        self._c = None
        self._sr_tensor = None

        # Frame size in samples
        self.frame_samples = int(sample_rate * frame_ms / 1000)

        if frame_ms not in SUPPORTED_FRAME_MS:
            logger.warning(
                "Frame size %d ms not in supported sizes %s; using anyway",
                frame_ms, SUPPORTED_FRAME_MS,
            )

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> bool:
        """
        Load the Silero VAD ONNX model.

        If the model file does not exist, attempts to download it from GitHub.
        Returns True if the model was loaded successfully, False otherwise.
        """
        try:
            import onnxruntime as ort
        except ImportError:
            logger.error(
                "onnxruntime is not installed. Install with: pip install onnxruntime"
            )
            return False

        # Auto-download model if missing
        if not self.model_path.exists():
            logger.info("VAD model not found at %s — attempting download...", self.model_path)
            if not self._download_model():
                return False

        try:
            # Use CPU provider only — no GPU needed for VAD
            sess_options = ort.SessionOptions()
            sess_options.inter_op_num_threads = 1
            sess_options.intra_op_num_threads = 1
            sess_options.log_severity_level = 3  # Suppress ONNX warnings

            self._session = ort.InferenceSession(
                str(self.model_path),
                sess_options=sess_options,
                providers=["CPUExecutionProvider"],
            )

            # Initialise LSTM hidden states
            self.reset()
            self._loaded = True

            logger.info(
                "VAD engine loaded: model=%s, threshold=%.2f, frame=%dms",
                self.model_path.name, self.threshold, self.frame_ms,
            )
            return True

        except Exception as e:
            logger.error("Failed to load VAD model: %s", e)
            self._loaded = False
            return False

    def reset(self) -> None:
        """Reset the VAD state (LSTM hidden states) between recordings."""
        # Silero VAD uses 2-layer LSTM with 64 hidden units
        self._h = np.zeros((2, 1, 64), dtype=np.float32)
        self._c = np.zeros((2, 1, 64), dtype=np.float32)
        self._sr_tensor = np.array([self.sample_rate], dtype=np.int64)

    def is_speech(self, audio_frame: np.ndarray) -> bool:
        """
        Classify a single audio frame as speech or non-speech.

        Args:
            audio_frame: Float32 numpy array of shape (frame_samples,),
                         normalised to [-1, 1]. Must be exactly
                         self.frame_samples long.

        Returns:
            True if the frame contains speech above the threshold.
        """
        if not self._loaded or self._session is None:
            return True  # Fail-open: assume speech if VAD unavailable

        probability = self.get_speech_probability(audio_frame)
        return probability >= self.threshold

    def get_speech_probability(self, audio_frame: np.ndarray) -> float:
        """
        Get the speech probability for a single audio frame.

        Args:
            audio_frame: Float32 numpy array, shape (frame_samples,).

        Returns:
            Speech probability in [0.0, 1.0].
        """
        if not self._loaded or self._session is None:
            return 1.0  # Fail-open

        # Ensure correct shape: (1, frame_samples)
        if audio_frame.ndim == 1:
            audio_frame = audio_frame[np.newaxis, :]

        # Pad or truncate to expected frame size
        if audio_frame.shape[1] != self.frame_samples:
            padded = np.zeros((1, self.frame_samples), dtype=np.float32)
            copy_len = min(audio_frame.shape[1], self.frame_samples)
            padded[0, :copy_len] = audio_frame[0, :copy_len]
            audio_frame = padded

        try:
            ort_inputs = {
                "input": audio_frame.astype(np.float32),
                "h": self._h,
                "c": self._c,
                "sr": self._sr_tensor,
            }

            ort_outs = self._session.run(None, ort_inputs)
            out, self._h, self._c = ort_outs

            probability = float(out.squeeze())
            return max(0.0, min(1.0, probability))

        except Exception as e:
            logger.warning("VAD inference error: %s", e)
            return 1.0  # Fail-open on error

    def process_chunk(self, audio_bytes: bytes) -> list[dict]:
        """
        Process a chunk of raw PCM audio and return per-frame VAD results.

        This is a convenience method that handles the frame splitting and
        returns structured results for each frame.

        Args:
            audio_bytes: Raw 16-bit PCM bytes (mono, 16 kHz).

        Returns:
            List of dicts: [{ "is_speech": bool, "probability": float, "frame_index": int }]
        """
        if not self._loaded:
            # Return single result assuming all speech
            return [{"is_speech": True, "probability": 1.0, "frame_index": 0}]

        # Convert to float32
        if len(audio_bytes) < 2:
            return []

        samples = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        results = []
        frame_idx = 0

        for start in range(0, len(samples), self.frame_samples):
            frame = samples[start : start + self.frame_samples]
            if len(frame) < self.frame_samples:
                # Pad last frame
                padded = np.zeros(self.frame_samples, dtype=np.float32)
                padded[: len(frame)] = frame
                frame = padded

            prob = self.get_speech_probability(frame)
            results.append({
                "is_speech": prob >= self.threshold,
                "probability": prob,
                "frame_index": frame_idx,
            })
            frame_idx += 1

        return results

    def _download_model(self) -> bool:
        """Download the Silero VAD ONNX model from GitHub."""
        try:
            self.model_path.parent.mkdir(parents=True, exist_ok=True)
            logger.info("Downloading Silero VAD model from %s ...", SILERO_VAD_URL)
            urllib.request.urlretrieve(SILERO_VAD_URL, str(self.model_path))
            logger.info("VAD model downloaded to %s", self.model_path)
            return True
        except Exception as e:
            logger.error("Failed to download VAD model: %s", e)
            logger.error(
                "Please download manually from %s and place at %s",
                SILERO_VAD_URL, self.model_path,
            )
            return False

    def unload(self) -> None:
        """Release the ONNX session and free memory."""
        self._session = None
        self._h = None
        self._c = None
        self._loaded = False
        logger.info("VAD engine unloaded")
