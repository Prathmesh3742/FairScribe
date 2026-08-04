"""
FairScribe STT Service — Whisper Verification Engine (Faster-Whisper)

Runs a post-recording verification pass using Faster-Whisper (CTranslate2
optimised Whisper). This produces a higher-accuracy transcript than Vosk's
real-time streaming output, serving as the authoritative answer text.

The verification pass runs AFTER recording stops — it is NOT real-time.
Typical processing time: 2–8 seconds for a 2-minute answer on CPU.

Faster-Whisper uses CTranslate2 for efficient CPU inference with int8
quantisation. No GPU is required.

Model management:
    Faster-Whisper can auto-download models from Hugging Face on first use.
    For fully offline deployment, pre-download the model and point the
    config to the local directory. See models/README.md for instructions.
"""

from __future__ import annotations

import io
import logging
import time
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


class WhisperEngine:
    """
    Faster-Whisper verification engine.

    Usage:
        engine = WhisperEngine(model_size="base.en", device="cpu")
        engine.load()

        # After recording stops, verify the full audio:
        result = engine.transcribe(audio_bytes)
        # result = { "text": "...", "confidence": 0.95, "segments": [...] }

        # Or transcribe from a WAV buffer:
        result = engine.transcribe_wav(wav_bytes)
    """

    def __init__(
        self,
        model_size: str = "base.en",
        device: str = "cpu",
        compute_type: str = "int8",
        beam_size: int = 5,
        model_path: Optional[str] = None,
        language: str = "en",
    ):
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.model_path = model_path
        self.language = language
        self._model = None  # faster_whisper.WhisperModel instance
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> bool:
        """
        Load the Faster-Whisper model.

        If model_path points to a local directory containing a CTranslate2
        model, it is loaded directly. Otherwise, model_size is used to
        auto-download from Hugging Face (requires internet on first use).

        For fully offline deployment, pre-download the model:
            faster-whisper downloads models to ~/.cache/huggingface/hub/
            or convert a model manually with ct2-opus-mt-converter.

        Returns True on success, False on failure.
        """
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            logger.error(
                "faster-whisper is not installed. Install with: pip install faster-whisper"
            )
            return False

        try:
            # Determine the model source
            model_source = self.model_size  # Default: auto-download by name

            if self.model_path:
                model_dir = Path(self.model_path)
                if model_dir.exists() and model_dir.is_dir():
                    # Check for CTranslate2 model files
                    if (model_dir / "model.bin").exists():
                        model_source = str(model_dir)
                        logger.info(
                            "Using local Whisper model at %s", model_dir
                        )
                    else:
                        logger.warning(
                            "Model directory exists but no model.bin found: %s. "
                            "Falling back to model_size=%s (may require download).",
                            model_dir, self.model_size,
                        )
                else:
                    logger.info(
                        "Local model path %s not found. "
                        "Using model_size=%s (will auto-download on first use).",
                        self.model_path, self.model_size,
                    )

            logger.info(
                "Loading Whisper model: source=%s, device=%s, compute=%s",
                model_source, self.device, self.compute_type,
            )

            self._model = WhisperModel(
                model_source,
                device=self.device,
                compute_type=self.compute_type,
                cpu_threads=4,  # Use more threads for better real-time accuracy
                num_workers=1,
            )

            self._loaded = True
            logger.info("Whisper engine loaded successfully")
            return True

        except Exception as e:
            logger.error("Failed to load Whisper model: %s", e)
            self._loaded = False
            return False

    def transcribe(
        self,
        audio_bytes: bytes,
        sample_rate: int = 16000,
    ) -> dict:
        """
        Transcribe raw PCM audio bytes using Whisper.

        This is the verification pass — runs on the complete recorded audio
        after the candidate stops dictating. Not real-time.

        Args:
        Run Faster-Whisper on the complete audio buffer.

        Args:
            audio_bytes: Raw 16-bit PCM bytes (mono).
            sample_rate: Audio sample rate in Hz.
            vosk_transcript: Live transcript to guide Whisper and prevent paraphrasing.
            custom_vocabulary: Comma-separated domain-specific words to bias recognition.

        Returns:
            Dict containing final transcript, confidence, and segments.
        """
        if not self._loaded or self._model is None:
            logger.error("Cannot transcribe — Whisper model not loaded")
            return {
                "text": "",
                "confidence": 0.0,
                "segments": [],
                "processing_time_seconds": 0.0,
                "audio_duration_seconds": 0.0,
            }

        if len(audio_bytes) < 2:
            return {
                "text": "",
                "confidence": 0.0,
                "segments": [],
                "processing_time_seconds": 0.0,
                "audio_duration_seconds": 0.0,
            }

        start_time = time.monotonic()

        # Convert raw PCM to float32 numpy array
        audio_array = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        audio_duration = len(audio_array) / sample_rate

        # Initial prompt: guides Whisper to recognize spoken punctuation commands
        # and common academic/examination vocabulary. This significantly reduces
        # substitution errors for words that are frequently spoken by students.
        # By appending the Vosk transcript, we also force Whisper to stick strictly
        # to the candidate's original phrasing, effectively preventing it from
        # hallucinating or paraphrasing the answer.
        prompt_parts = [
            "The following is a student's examination answer. "
            "The student may speak punctuation commands: "
            "full stop, comma, question mark, exclamation mark, colon, semicolon, "
            "hyphen, apostrophe, new line, open bracket, close bracket."
        ]
        
        if custom_vocabulary:
            prompt_parts.append(f"Technical vocabulary includes: {custom_vocabulary}.")
            
        if vosk_transcript:
            prompt_parts.append(f"The answer starts like this: {vosk_transcript}")
            
        INITIAL_PROMPT = " ".join(prompt_parts)

        try:
            segments_iter, info = self._model.transcribe(
                audio_array,
                beam_size=self.beam_size,
                language=self.language,
                initial_prompt=INITIAL_PROMPT,
                # Disable conditioning on previous text to prevent hallucination chains
                # where one wrong word causes a cascade of further errors.
                condition_on_previous_text=False,
                # Use Whisper's built-in VAD for better sentence boundary detection
                vad_filter=True,
                vad_parameters=dict(
                    min_silence_duration_ms=500,  # Longer silence = clearer sentence boundaries
                    speech_pad_ms=100,             # More context around speech segments
                    threshold=0.45,                # Slightly lower threshold = more speech captured
                ),
                # Suppress common false positive tokens
                suppress_tokens=[-1],
                word_timestamps=False,  # Segment-level is sufficient for verification
                # Temperature fallback: if decoding confidence is low, retry with
                # higher temperature (more diversity) to avoid getting stuck.
                temperature=(0.0, 0.2, 0.4),
                compression_ratio_threshold=2.4,
                log_prob_threshold=-1.0,
                no_speech_threshold=0.6,
            )

            # Collect segments (the iterator is lazy — must consume it)
            segments = []
            full_text_parts = []
            total_confidence = 0.0

            for segment in segments_iter:
                seg_data = {
                    "text": segment.text.strip(),
                    "start": segment.start,
                    "end": segment.end,
                    "confidence": 1.0 - segment.no_speech_prob,
                }
                segments.append(seg_data)
                full_text_parts.append(segment.text.strip())
                total_confidence += seg_data["confidence"]

            full_text = " ".join(full_text_parts).strip()
            avg_confidence = total_confidence / len(segments) if segments else 0.0
            processing_time = time.monotonic() - start_time

            logger.info(
                "Whisper transcription complete: %.1fs audio → %.1fs processing, "
                "%d segments, confidence=%.2f",
                audio_duration, processing_time, len(segments), avg_confidence,
            )

            return {
                "text": full_text,
                "confidence": avg_confidence,
                "segments": segments,
                "processing_time_seconds": processing_time,
                "audio_duration_seconds": audio_duration,
            }

        except Exception as e:
            processing_time = time.monotonic() - start_time
            logger.error("Whisper transcription failed: %s", e)
            return {
                "text": "",
                "confidence": 0.0,
                "segments": [],
                "processing_time_seconds": processing_time,
                "audio_duration_seconds": audio_duration,
            }

    def transcribe_wav(self, wav_bytes: bytes) -> dict:
        """
        Transcribe a WAV file buffer using Whisper.

        Convenience method that accepts a complete WAV file (with header)
        rather than raw PCM. Used when audio is stored as WAV.

        Args:
            wav_bytes: Complete WAV file bytes.

        Returns:
            Same format as transcribe().
        """
        if not self._loaded or self._model is None:
            return {
                "text": "",
                "confidence": 0.0,
                "segments": [],
                "processing_time_seconds": 0.0,
                "audio_duration_seconds": 0.0,
            }

        start_time = time.monotonic()

        try:
            import soundfile as sf

            # Read WAV from memory
            audio_array, sample_rate = sf.read(io.BytesIO(wav_bytes), dtype="float32")

            # Ensure mono
            if audio_array.ndim > 1:
                audio_array = audio_array.mean(axis=1)

            audio_duration = len(audio_array) / sample_rate

            segments_iter, info = self._model.transcribe(
                audio_array,
                beam_size=self.beam_size,
                language=self.language,
                vad_filter=True,
                word_timestamps=False,
            )

            segments = []
            full_text_parts = []
            total_confidence = 0.0

            for segment in segments_iter:
                seg_data = {
                    "text": segment.text.strip(),
                    "start": segment.start,
                    "end": segment.end,
                    "confidence": 1.0 - segment.no_speech_prob,
                }
                segments.append(seg_data)
                full_text_parts.append(segment.text.strip())
                total_confidence += seg_data["confidence"]

            full_text = " ".join(full_text_parts).strip()
            avg_confidence = total_confidence / len(segments) if segments else 0.0
            processing_time = time.monotonic() - start_time

            return {
                "text": full_text,
                "confidence": avg_confidence,
                "segments": segments,
                "processing_time_seconds": processing_time,
                "audio_duration_seconds": audio_duration,
            }

        except Exception as e:
            processing_time = time.monotonic() - start_time
            logger.error("Whisper WAV transcription failed: %s", e)
            return {
                "text": "",
                "confidence": 0.0,
                "segments": [],
                "processing_time_seconds": processing_time,
                "audio_duration_seconds": 0.0,
            }

    def unload(self) -> None:
        """Release the Whisper model and free memory."""
        self._model = None
        self._loaded = False
        logger.info("Whisper engine unloaded")
