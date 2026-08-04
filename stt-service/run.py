"""
FairScribe STT Service — Entry Point

Starts the FastAPI server with uvicorn.
Usage: python run.py
"""

import sys
import os

# Ensure the stt-service directory is on the Python path so that
# `stt_service` is importable regardless of where the script is invoked from.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from stt_service.app import main  # noqa: E402

if __name__ == "__main__":
    main()
