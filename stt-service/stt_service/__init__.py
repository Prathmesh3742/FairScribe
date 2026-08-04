"""
FairScribe Offline STT Service.

A completely offline Speech-to-Text backend for the FairScribe
examination terminal. Uses Vosk for real-time streaming recognition,
Silero VAD for voice activity detection, and Faster-Whisper for
post-recording verification.

No cloud APIs. No internet. No OpenAI. No Google Speech. No Azure.
"""

__version__ = "0.1.0"
