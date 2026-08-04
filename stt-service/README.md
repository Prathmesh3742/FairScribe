# FairScribe STT Service

**Completely offline Speech-to-Text backend** for the FairScribe examination terminal.

> No cloud APIs. No internet. No OpenAI. No Google Speech. No Azure.

This service provides:
- **Real-time streaming recognition** via Vosk (Indian English / US English)
- **Voice Activity Detection** via Silero VAD (ONNX, ~2MB)
- **Post-recording verification** via Faster-Whisper (CTranslate2 optimised)
- **Session management** for per-question recording lifecycle
- **WebSocket streaming** for low-latency audio processing

---

## Quick Start

### Prerequisites

- **Python 3.9+** (3.11 recommended)
- **pip** (package manager)
- ~300 MB disk space for models

### 1. Create virtual environment

```bash
cd stt-service

# Create venv
python -m venv venv

# Activate (Windows PowerShell)
.\venv\Scripts\Activate.ps1

# Activate (macOS/Linux)
source venv/bin/activate
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Download models

See [models/README.md](models/README.md) for detailed instructions.

**Quick version (Windows PowerShell):**

```powershell
cd models

# Vosk model (Indian English, ~40 MB)
Invoke-WebRequest -Uri "https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip" -OutFile "vosk-model.zip"
Expand-Archive -Path "vosk-model.zip" -DestinationPath "."
Remove-Item "vosk-model.zip"

cd ..
```

> The Silero VAD model (~2 MB) is auto-downloaded on first run.
> The Whisper model (~150 MB) is auto-downloaded from Hugging Face on first use.

### 4. Run the service

```bash
python run.py
```

The service starts on `http://localhost:5400`.

### 5. Verify

```bash
curl http://localhost:5400/api/health
```

Expected response:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime_seconds": 5.2,
  "engines": {
    "vad":     { "status": "ready", "model_loaded": true },
    "vosk":    { "status": "ready", "model_loaded": true },
    "whisper": { "status": "ready", "model_loaded": true }
  },
  "active_sessions": 0
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    FastAPI Application                       │
│                                                             │
│  ┌───────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │  Health    │  │  Sessions    │  │  WebSocket        │   │
│  │  GET /api  │  │  POST/GET/   │  │  /api/sessions/   │   │
│  │  /health   │  │  DELETE      │  │  {id}/stream      │   │
│  └───────────┘  └──────┬───────┘  └─────────┬─────────┘   │
│                        │                     │              │
│  ┌─────────────────────┴─────────────────────┘              │
│  │              Session Manager                             │
│  │    (lifecycle, engine coordination)                      │
│  └──┬──────────┬──────────────┬──────────────┘              │
│     │          │              │                              │
│  ┌──┴───┐  ┌──┴──────┐  ┌───┴────────┐  ┌──────────┐     │
│  │ VAD  │  │  Vosk   │  │  Whisper   │  │  Audio   │     │
│  │Engine│  │ Engine  │  │  Engine    │  │Processor │     │
│  └──────┘  └─────────┘  └───────────┘  └──────────┘     │
└─────────────────────────────────────────────────────────────┘
```

---

## API Reference

### Health Check

```
GET /api/health
```

Returns service status, engine availability, and config summary.

---

### Sessions

#### Create Session

```
POST /api/sessions
Content-Type: application/json

{
  "student_id": "STU-2024-001",
  "exam_id": "EXAM001",
  "question_id": "Q001",
  "language": "en"
}
```

**Response (201):**
```json
{
  "session_id": "a1b2c3d4-...",
  "status": "created",
  "student_id": "STU-2024-001",
  "exam_id": "EXAM001",
  "question_id": "Q001",
  "language": "en",
  "created_at": "2024-01-15T09:30:00Z",
  "updated_at": "2024-01-15T09:30:00Z",
  "audio_duration_seconds": 0.0,
  "vosk_transcript": ""
}
```

#### List Sessions

```
GET /api/sessions
```

#### Get Session

```
GET /api/sessions/{session_id}
```

#### Delete Session

```
DELETE /api/sessions/{session_id}
```

---

### Audio Streaming (WebSocket)

```
WS /api/sessions/{session_id}/stream
```

**Protocol:**
1. Create a session via `POST /api/sessions`
2. Connect to the WebSocket endpoint
3. Send binary frames: 16-bit PCM, 16 kHz, mono
4. Receive JSON recognition results

**Server → Client messages:**

```json
{
  "session_id": "a1b2c3d4-...",
  "type": "partial",
  "text": "hello this is",
  "confidence": 0.0,
  "is_speech": true,
  "timestamp_ms": 1500.0
}
```

```json
{
  "session_id": "a1b2c3d4-...",
  "type": "final",
  "text": "hello this is a test",
  "confidence": 0.92,
  "is_speech": true,
  "timestamp_ms": 3000.0
}
```

---

### Stop Recording + Verification

```
POST /api/sessions/{session_id}/stop
Content-Type: application/json

{
  "run_whisper_verification": true
}
```

**Response (200):**
```json
{
  "session_id": "a1b2c3d4-...",
  "vosk_transcript": "hello this is a test",
  "whisper_transcript": "Hello, this is a test.",
  "final_transcript": "Hello, this is a test.",
  "whisper_available": true,
  "whisper_confidence": 0.95,
  "audio_duration_seconds": 3.2,
  "processing_time_seconds": 1.8,
  "status": "completed"
}
```

---

## Configuration

All configuration lives in `config.yaml`. Override any value via environment
variables prefixed with `FAIRSCRIBE_STT_`:

```bash
FAIRSCRIBE_STT_PORT=5401 python run.py
```

Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `host` | `127.0.0.1` | Bind address |
| `port` | `5400` | Server port |
| `audio.sample_rate` | `16000` | Required by Vosk/Whisper |
| `vad.threshold` | `0.5` | Speech detection threshold |
| `vosk.model_path` | `models/vosk-model-small-en-in-0.4` | Vosk model directory |
| `whisper.model_size` | `base.en` | Whisper model size |
| `whisper.device` | `cpu` | `cpu` or `cuda` |
| `session.max_concurrent` | `1` | Max simultaneous sessions |

---

## Electron Integration (Phase 3 — Next Step)

This service is designed to be launched and managed by the Electron main
process. The integration path:

1. **Electron spawns** this Python service as a child process on app startup
2. **Health check** polling until the service is ready
3. **IPC bridge** maps `stt:*` channels to HTTP/WebSocket calls:
   - `stt:startSession` → `POST /api/sessions`
   - `stt:sendAudio` → WebSocket binary frame
   - `stt:stopRecording` → `POST /api/sessions/{id}/stop`
   - `stt:deleteSession` → `DELETE /api/sessions/{id}`
4. **Preload** exposes `window.fairscribe.stt.*` to the renderer
5. **React** components consume the transcript stream

No changes to this Python service are needed for the integration —
the HTTP/WebSocket API is the stable contract.

---

## Project Structure

```
stt-service/
├── run.py                    # Entry point
├── config.yaml               # Runtime configuration
├── requirements.txt          # Pinned dependencies
├── pyproject.toml            # Project metadata
├── .gitignore
├── stt_service/
│   ├── __init__.py           # Package version
│   ├── app.py                # FastAPI factory + startup/shutdown
│   ├── config.py             # Pydantic settings + YAML loader
│   ├── models.py             # Request/response schemas
│   ├── engine/
│   │   ├── __init__.py
│   │   ├── audio_processor.py  # PCM resampling, chunking, WAV
│   │   ├── vad.py              # Silero VAD (ONNX)
│   │   ├── vosk_engine.py      # Vosk streaming ASR
│   │   └── whisper_engine.py   # Faster-Whisper verification
│   ├── session/
│   │   ├── __init__.py
│   │   ├── state.py            # Session state machine + buffer
│   │   └── manager.py          # Lifecycle orchestration
│   └── routes/
│       ├── __init__.py
│       ├── health.py           # GET /api/health
│       ├── sessions.py         # Session CRUD + stop
│       └── streaming.py        # WebSocket audio stream
└── models/
    ├── .gitkeep
    └── README.md               # Model download instructions
```
