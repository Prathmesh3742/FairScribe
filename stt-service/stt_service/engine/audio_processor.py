"""
FairScribe STT Service — Audio Processor

Handles audio resampling, format conversion, and chunking.
All audio in the FairScribe pipeline is 16-bit PCM, 16 kHz, mono.

The Electron main process will capture microphone audio via the Web Audio
API (or Electron's desktopCapturer) and send raw PCM chunks over IPC.
This module normalises whatever arrives into the format expected by
Vosk and Whisper.
"""

from __future__ import annotations

import io
import logging
import struct
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# Target format for all engines
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1
TARGET_SAMPLE_WIDTH = 2  # 16-bit = 2 bytes per sample


class AudioProcessor:
    """
    Stateless audio processing utilities.

    All methods are class-level or static — no instance state is needed.
    This makes it safe to share across sessions.
    """

    def __init__(self, sample_rate: int = TARGET_SAMPLE_RATE, channels: int = TARGET_CHANNELS):
        self.sample_rate = sample_rate
        self.channels = channels
        self._bytes_per_sample = TARGET_SAMPLE_WIDTH
        logger.info(
            "AudioProcessor initialised: %d Hz, %d ch, %d-bit",
            self.sample_rate, self.channels, self._bytes_per_sample * 8,
        )

    def bytes_to_numpy(self, audio_bytes: bytes) -> np.ndarray:
        """
        Convert raw 16-bit PCM bytes to a float32 numpy array normalised to [-1, 1].

        Args:
            audio_bytes: Raw PCM bytes (16-bit signed little-endian).

        Returns:
            Float32 numpy array.
        """
        if len(audio_bytes) == 0:
            return np.array([], dtype=np.float32)

        # Ensure even number of bytes (16-bit samples)
        if len(audio_bytes) % 2 != 0:
            audio_bytes = audio_bytes[:-1]

        samples = np.frombuffer(audio_bytes, dtype=np.int16)
        return samples.astype(np.float32) / 32768.0

    def numpy_to_bytes(self, audio_array: np.ndarray) -> bytes:
        """
        Convert a float32 numpy array back to 16-bit PCM bytes.

        Args:
            audio_array: Float32 array normalised to [-1, 1].

        Returns:
            Raw PCM bytes.
        """
        if len(audio_array) == 0:
            return b""

        # Clip to prevent overflow
        clipped = np.clip(audio_array, -1.0, 1.0)
        int_samples = (clipped * 32767).astype(np.int16)
        return int_samples.tobytes()

    def resample(
        self,
        audio_bytes: bytes,
        source_rate: int,
        target_rate: Optional[int] = None,
    ) -> bytes:
        """
        Resample PCM audio from source_rate to target_rate using linear interpolation.

        For exam-quality speech recognition, linear interpolation is sufficient.
        The audio is always mono 16-bit PCM.

        Args:
            audio_bytes: Raw 16-bit PCM bytes at source_rate.
            source_rate: Source sample rate in Hz.
            target_rate: Target sample rate (defaults to self.sample_rate).

        Returns:
            Resampled raw 16-bit PCM bytes.
        """
        if target_rate is None:
            target_rate = self.sample_rate

        if source_rate == target_rate:
            return audio_bytes

        audio_float = self.bytes_to_numpy(audio_bytes)
        if len(audio_float) == 0:
            return b""

        # Calculate resampled length
        duration = len(audio_float) / source_rate
        target_length = int(duration * target_rate)

        if target_length == 0:
            return b""

        # Linear interpolation resampling
        source_indices = np.linspace(0, len(audio_float) - 1, target_length)
        resampled = np.interp(source_indices, np.arange(len(audio_float)), audio_float)

        return self.numpy_to_bytes(resampled.astype(np.float32))

    def chunk_audio(
        self,
        audio_bytes: bytes,
        chunk_duration_ms: int = 30,
    ) -> list[bytes]:
        """
        Split PCM audio into fixed-duration chunks.

        Used for feeding audio to the VAD engine in consistent frame sizes.

        Args:
            audio_bytes: Raw 16-bit PCM bytes.
            chunk_duration_ms: Duration of each chunk in milliseconds.

        Returns:
            List of PCM byte chunks. The last chunk may be shorter.
        """
        bytes_per_chunk = int(
            self.sample_rate * self._bytes_per_sample * chunk_duration_ms / 1000
        )

        if bytes_per_chunk == 0:
            return [audio_bytes] if audio_bytes else []

        chunks = []
        for i in range(0, len(audio_bytes), bytes_per_chunk):
            chunk = audio_bytes[i : i + bytes_per_chunk]
            # Pad the last chunk to full size if needed (for VAD frame alignment)
            if len(chunk) < bytes_per_chunk:
                chunk = chunk + b"\x00" * (bytes_per_chunk - len(chunk))
            chunks.append(chunk)

        return chunks

    def compute_rms(self, audio_bytes: bytes) -> float:
        """
        Compute the RMS (root mean square) level of a PCM audio buffer.

        Useful for audio level metering in the UI.

        Args:
            audio_bytes: Raw 16-bit PCM bytes.

        Returns:
            RMS level as a float (0.0 = silence, 1.0 = maximum).
        """
        audio_float = self.bytes_to_numpy(audio_bytes)
        if len(audio_float) == 0:
            return 0.0
        rms = float(np.sqrt(np.mean(audio_float ** 2)))
        return min(rms, 1.0)

    def compute_duration_seconds(self, audio_bytes: bytes) -> float:
        """
        Compute the duration of PCM audio in seconds.

        Args:
            audio_bytes: Raw 16-bit PCM bytes.

        Returns:
            Duration in seconds.
        """
        num_samples = len(audio_bytes) // self._bytes_per_sample
        return num_samples / self.sample_rate if self.sample_rate > 0 else 0.0

    def create_wav_buffer(self, audio_bytes: bytes) -> bytes:
        """
        Wrap raw PCM bytes in a WAV header for Whisper consumption.

        Whisper expects WAV or MP3 input. This creates a minimal valid
        WAV file in memory without writing to disk.

        Args:
            audio_bytes: Raw 16-bit PCM bytes (mono, 16 kHz).

        Returns:
            Complete WAV file bytes.
        """
        num_samples = len(audio_bytes) // self._bytes_per_sample
        data_size = num_samples * self._bytes_per_sample
        file_size = 36 + data_size  # 36 = header size minus "RIFF" + size field

        buf = io.BytesIO()
        # RIFF header
        buf.write(b"RIFF")
        buf.write(struct.pack("<I", file_size))
        buf.write(b"WAVE")

        # fmt chunk
        buf.write(b"fmt ")
        buf.write(struct.pack("<I", 16))                # chunk size
        buf.write(struct.pack("<H", 1))                  # PCM format
        buf.write(struct.pack("<H", self.channels))      # channels
        buf.write(struct.pack("<I", self.sample_rate))    # sample rate
        byte_rate = self.sample_rate * self.channels * self._bytes_per_sample
        buf.write(struct.pack("<I", byte_rate))           # byte rate
        block_align = self.channels * self._bytes_per_sample
        buf.write(struct.pack("<H", block_align))         # block align
        buf.write(struct.pack("<H", self._bytes_per_sample * 8))  # bits per sample

        # data chunk
        buf.write(b"data")
        buf.write(struct.pack("<I", data_size))
        buf.write(audio_bytes[:data_size])

        return buf.getvalue()
