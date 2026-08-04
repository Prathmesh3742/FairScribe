"""
FairScribe STT Service — Vosk Streaming Speech Recognition Engine

Wraps the Vosk offline speech recognition library for real-time
streaming transcription. Vosk processes audio chunks incrementally
and returns partial + final recognition results.

Vosk models are self-contained directories containing the acoustic
model, language model, and configuration. They must be downloaded
separately — see models/README.md for instructions.

Key design decisions:
    - One KaldiRecognizer per session (stateful — tracks utterance context)
    - Recogniser is created fresh for each recording session
    - Thread-safe: each session gets its own recogniser instance
    - The Vosk Model is loaded once and shared across sessions
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class VoskEngine:
    """
    Vosk streaming speech recognition engine.

    Usage:
        engine = VoskEngine(model_path="models/vosk-model-small-en-in-0.4")
        engine.load()

        # Create a recogniser for a new recording session:
        recogniser = engine.create_recogniser()

        # Feed audio chunks:
        result = engine.process_chunk(recogniser, audio_bytes)
        # result = { "type": "partial"|"final", "text": "...", "confidence": 0.0-1.0 }

        # Get final result when recording stops:
        final = engine.finalise(recogniser)
    """

    def __init__(self, model_path: str = "models/vosk-model-small-en-in-0.4", sample_rate: int = 16000):
        self.model_path = Path(model_path)
        self.sample_rate = sample_rate
        self._model = None  # vosk.Model instance
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> bool:
        """
        Load the Vosk model from disk.

        The model directory must exist and contain valid Vosk model files.
        Returns True on success, False on failure.
        """
        try:
            import vosk
        except ImportError:
            logger.error(
                "vosk is not installed. Install with: pip install vosk"
            )
            return False

        if not self.model_path.exists():
            logger.error(
                "Vosk model directory not found: %s. "
                "Download a model from https://alphacephei.com/vosk/models "
                "and extract it to this path.",
                self.model_path,
            )
            return False

        if not self.model_path.is_dir():
            logger.error(
                "Vosk model path is not a directory: %s", self.model_path
            )
            return False

        try:
            # Suppress Vosk's own logging (it prints to stderr by default)
            vosk.SetLogLevel(-1)

            self._model = vosk.Model(str(self.model_path))
            self._loaded = True

            logger.info(
                "Vosk engine loaded: model=%s, sample_rate=%d",
                self.model_path.name, self.sample_rate,
            )
            return True

        except Exception as e:
            logger.error("Failed to load Vosk model: %s", e)
            self._loaded = False
            return False

    def create_recogniser(self) -> Optional[object]:
        """
        Create a new KaldiRecognizer instance for a recording session.

        Each recording session should have its own recogniser so that
        acoustic context is isolated between questions.

        Returns:
            A vosk.KaldiRecognizer instance, or None if the engine is not loaded.
        """
        if not self._loaded or self._model is None:
            logger.error("Cannot create recogniser — Vosk model not loaded")
            return None

        try:
            import vosk
            recogniser = vosk.KaldiRecognizer(self._model, self.sample_rate)
            # Enable word-level timestamps for confidence scoring
            recogniser.SetWords(True)
            recogniser.SetPartialWords(True)
            return recogniser
        except Exception as e:
            logger.error("Failed to create Vosk recogniser: %s", e)
            return None

    def process_chunk(self, recogniser: object, audio_bytes: bytes) -> dict:
        """
        Feed an audio chunk to the recogniser and return the result.

        Args:
            recogniser: A vosk.KaldiRecognizer instance.
            audio_bytes: Raw 16-bit PCM bytes (mono, 16 kHz).

        Returns:
            Dict with keys:
                - type: "partial" or "final"
                - text: Recognised text
                - confidence: Average word confidence (0.0-1.0), 0 for partials
                - words: List of word-level results (for finals only)
        """
        if recogniser is None:
            return {"type": "partial", "text": "", "confidence": 0.0, "words": []}

        try:
            # AcceptWaveform returns True when it detects an utterance boundary
            if recogniser.AcceptWaveform(audio_bytes):
                # Final result for this utterance
                result_json = recogniser.Result()
                result = json.loads(result_json)
                text = result.get("text", "").strip()
                words = result.get("result", [])
                confidence = self._compute_confidence(words)

                return {
                    "type": "final",
                    "text": text,
                    "confidence": confidence,
                    "words": words,
                }
            else:
                # Partial result (interim — still processing)
                partial_json = recogniser.PartialResult()
                partial = json.loads(partial_json)
                text = partial.get("partial", "").strip()

                return {
                    "type": "partial",
                    "text": text,
                    "confidence": 0.0,
                    "words": [],
                }

        except Exception as e:
            logger.warning("Vosk processing error: %s", e)
            return {"type": "partial", "text": "", "confidence": 0.0, "words": []}

    def finalise(self, recogniser: object) -> dict:
        """
        Get the final recognition result from the recogniser.

        Call this when recording stops to flush any remaining audio
        in the recogniser's buffer.

        Args:
            recogniser: A vosk.KaldiRecognizer instance.

        Returns:
            Same format as process_chunk() but always type="final".
        """
        if recogniser is None:
            return {"type": "final", "text": "", "confidence": 0.0, "words": []}

        try:
            result_json = recogniser.FinalResult()
            result = json.loads(result_json)
            text = result.get("text", "").strip()
            words = result.get("result", [])
            confidence = self._compute_confidence(words)

            return {
                "type": "final",
                "text": text,
                "confidence": confidence,
                "words": words,
            }
        except Exception as e:
            logger.warning("Vosk finalise error: %s", e)
            return {"type": "final", "text": "", "confidence": 0.0, "words": []}

    @staticmethod
    def _compute_confidence(words: list[dict]) -> float:
        """
        Compute average confidence from Vosk word-level results.

        Args:
            words: List of word dicts from Vosk, each with a "conf" field.

        Returns:
            Average confidence in [0.0, 1.0], or 0.0 if no words.
        """
        if not words:
            return 0.0

        confidences = [w.get("conf", 0.0) for w in words if "conf" in w]
        if not confidences:
            return 0.0

        return sum(confidences) / len(confidences)

    def unload(self) -> None:
        """Release the Vosk model and free memory."""
        self._model = None
        self._loaded = False
        logger.info("Vosk engine unloaded")
