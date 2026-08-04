# FairScribe STT — Model Download Instructions

This directory holds the offline speech recognition models. These are
**NOT checked into Git** (they are large binary files). You must download
them manually before running the STT service.

---

## Required Models

### 1. Vosk Model (Streaming Recognition)

The primary real-time speech recognition model. Choose ONE:

| Model | Size | Accuracy | Download |
|-------|------|----------|----------|
| `vosk-model-small-en-in-0.4` | ~40 MB | Good (Indian English) | [Download](https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip) |
| `vosk-model-en-in-0.5` | ~1 GB | Better (Indian English) | [Download](https://alphacephei.com/vosk/models/vosk-model-en-in-0.5.zip) |
| `vosk-model-small-en-us-0.15` | ~40 MB | Good (US English) | [Download](https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip) |

**Installation:**

```bash
# From the stt-service/ directory:
cd models

# Download and extract (example: Indian English small model)
curl -LO https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip
tar -xf vosk-model-small-en-in-0.4.zip
rm vosk-model-small-en-in-0.4.zip

# Verify the directory structure:
# models/vosk-model-small-en-in-0.4/
#   ├── am/
#   ├── conf/
#   ├── graph/
#   ├── ivector/
#   └── README
```

> **Windows users:** Use `Expand-Archive` in PowerShell:
> ```powershell
> Invoke-WebRequest -Uri "https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip" -OutFile "vosk-model-small-en-in-0.4.zip"
> Expand-Archive -Path "vosk-model-small-en-in-0.4.zip" -DestinationPath "."
> Remove-Item "vosk-model-small-en-in-0.4.zip"
> ```

---

### 2. Silero VAD Model (Voice Activity Detection)

~2 MB ONNX model. **Auto-downloaded** on first run if not present.

If you need to download manually:

```bash
curl -LO https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
# Place at: models/silero_vad.onnx
```

---

### 3. Faster-Whisper Model (Verification — Optional)

Used for post-recording verification. **Auto-downloaded** from Hugging Face
on first use if not present locally.

For fully offline deployment, pre-download:

```bash
# Option A: Let faster-whisper download automatically (requires internet once)
# The model is cached in ~/.cache/huggingface/hub/

# Option B: Use CTranslate2 converter for a local copy
pip install ctranslate2
ct2-opus-mt-converter --model openai/whisper-base.en --output_dir models/whisper
```

Available model sizes:

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| `tiny.en` | ~75 MB | Fastest | Lower |
| `base.en` | ~150 MB | Fast | Good (recommended) |
| `small.en` | ~500 MB | Moderate | Better |

---

## Directory Structure After Download

```
models/
├── .gitkeep
├── README.md                          ← this file
├── silero_vad.onnx                    ← ~2 MB (auto-downloaded)
├── vosk-model-small-en-in-0.4/        ← ~40 MB
│   ├── am/
│   ├── conf/
│   ├── graph/
│   ├── ivector/
│   └── README
└── whisper/                           ← ~150 MB (optional, auto-downloaded)
    ├── model.bin
    ├── config.json
    └── ...
```

## Configuration

After downloading models, update `config.yaml` if you chose a different
model than the default:

```yaml
vosk:
  model_path: "models/vosk-model-small-en-in-0.4"  # ← your model directory

whisper:
  model_size: "base.en"
  model_path: "models/whisper"  # ← your CTranslate2 model directory
```
