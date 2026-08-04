# FairScribe

**Secure offline speech-to-text examination terminal** — a fully voice-controlled digital alternative to human scribes for candidates with motor/physical disabilities.

> **Phase 1–4 build** — Authentication, Question Paper Rendering, Offline STT (Vosk + Whisper + Silero VAD), and Voice Command Engine. Fully hands-free examination experience with no cloud dependencies.

---

## Features

### Authentication (Phase 1)
- Two-gate authentication: Invigilator PIN → Student credentials
- Kiosk mode activation on successful login
- Tamper-evident audit log with hash chain

### Question Paper Rendering (Phase 2)
- Multi-section exam with sectioned navigation
- Question palette with 5-status color coding
- Countdown timer
- Accessibility controls (zoom 80%–200%, high contrast mode)
- Jump-to-question numbered buttons

### Speech-to-Text Dictation (Phase 3)
- **Vosk** real-time streaming recognition (offline)
- **Silero VAD** voice activity detection
- **Faster-Whisper** post-recording verification
- Audio capture via AudioWorklet (16kHz mono PCM)
- Live partial + final transcript display
- Pause/resume recording support

### Voice Command Engine (Phase 4)
- **26 voice commands** across 6 categories for fully hands-free operation
- Fuzzy command matching with Levenshtein distance (tolerates STT errors)
- Dual-mode state machine: Command Mode ↔ Dictation Mode
- Parametric commands ("Go to question 5")
- Undo/redo answer editing with 50-entry history
- Dual-layer command detection prevents commands from leaking into answers
- Offline TTS announcements via `speechSynthesis` API
- Voice Command Reference modal accessible via voice or UI button
- Context-sensitive command suggestions in the UI
- Voice-controlled exam submission with spoken confirmation
- Configurable command aliases and confidence thresholds

---

## Voice Command Tutorial

FairScribe provides **26 voice commands** that enable a completely hands-free examination experience. All commands use fuzzy matching — slight mispronunciations or STT transcription errors are automatically tolerated.

### How Voice Modes Work

The voice engine operates in distinct modes. Each command is only active in specific modes:

| Mode | When Active | What Happens |
|------|-------------|-------------|
| **Command Mode** | After login, between recordings | All navigation, review, and help commands are recognized |
| **Recording** | While dictating an answer | Speech is transcribed as answer text; only recording controls and editing commands are active |
| **Paused** | After saying "pause recording" | Dictation is paused; editing, review, and help commands are available |
| **Confirming Submit** | After saying "submit exam" | Only "confirm submit" and "cancel" are recognized |

> **Tip:** Say **"help"** or **"view commands"** at any time in Command or Paused mode to see all available commands on screen.

---

### 🎤 Recording Commands

These commands control the dictation lifecycle — starting, stopping, pausing, and resuming voice-to-text transcription.

| Command | Aliases | Active Mode | Description |
|---------|---------|-------------|-------------|
| **"Start recording"** | "begin recording", "start dictation", "begin dictation", "start dictating" | Command | Opens the microphone and begins transcribing speech as the answer |
| **"Stop recording"** | "end recording", "stop dictation", "finish recording", "done recording", "stop dictating" | Recording, Paused | Stops dictation and triggers Whisper verification of the transcript |
| **"Pause recording"** | "pause dictation", "pause" | Recording | Suspends the microphone; you can review/edit your answer with voice commands while paused |
| **"Resume recording"** | "resume dictation", "continue recording", "continue dictation", "resume" | Paused | Resumes dictation seamlessly from where you paused |

**Usage example — Typical dictation flow:**
```
You: "Start recording"
  → TTS: "Recording started. Speak your answer now."
You: "The mitochondria is the powerhouse of the cell..."
  → Answer text appears in real time
You: "Pause recording"
  → TTS: "Recording paused."
You: "Read answer"
  → TTS reads back what you've dictated so far
You: "Delete last word"
  → Removes the last word from the answer
You: "Resume recording"
  → TTS: "Recording started. Speak your answer now."
You: "...which produces ATP through oxidative phosphorylation."
You: "Stop recording"
  → TTS: "Processing your answer." (Whisper verification runs)
```

---

### 🧭 Navigation Commands

Navigate between questions and sections entirely by voice. If recording is active, it is automatically stopped before navigating.

| Command | Aliases | Active Mode | Description |
|---------|---------|-------------|-------------|
| **"Next question"** | "go next", "move next", "next" | Command | Save the current answer and navigate to the next question |
| **"Previous question"** | "go back", "go previous", "last question", "previous" | Command | Navigate to the previous question |
| **"Next section"** | "go to next section", "move to next section" | Command | Jump to the first question of the next exam section |
| **"Previous section"** | "go to previous section", "go back a section" | Command | Jump to the first question of the previous exam section |
| **"Go to question [N]"** | "question number [N]", "jump to question [N]" | Command | Jump directly to question number N (global index across all sections) |

**Usage example — Navigating the exam:**
```
You: "Next question"
  → TTS: "Next Question" — navigates to Q2
You: "Go to question 15"
  → TTS: "Question 15" — jumps directly to Q15
You: "Previous section"
  → TTS: "Previous section" — jumps to first question of the prior section
You: "Go back"
  → TTS: "Previous Question" — navigates one question back
```

---

### ✏️ Editing Commands

Edit your dictated answer by voice — insert line breaks, delete words, undo/redo changes, or clear the answer entirely. Most editing commands work in both **Command** and **Paused** mode.

| Command | Aliases | Active Mode | Description |
|---------|---------|-------------|-------------|
| **"New line"** | "line break", "next line", "enter" | Recording, Paused | Insert a line break (`\n`) in the answer |
| **"Delete last word"** | "remove last word", "backspace", "undo word" | Recording, Paused | Remove the most recently transcribed word |
| **"Undo"** | "undo that", "undo change" | Command, Paused | Undo the last edit (up to 50 steps) |
| **"Redo"** | "redo that", "redo change" | Command, Paused | Redo a previously undone edit |
| **"Clear answer"** | "clear", "clear my answer", "erase answer", "delete answer", "clear text", "clear response" | Command, Paused | Clear the entire answer text for the current question |

**Usage example — Correcting a mistake while paused:**
```
You: "Pause recording"
  → TTS: "Recording paused."
You: "Delete last word"
  → TTS: "Word deleted" — removes the last word
You: "Delete last word"
  → TTS: "Word deleted" — removes another word
You: "Undo"
  → TTS: "Undo" — restores the last deleted word
You: "New line"
  → TTS: "New line" — inserts a paragraph break
You: "Resume recording"
  → Continues dictation from where you left off
```

**Usage example — Starting over:**
```
You: "Clear answer"
  → TTS: "Answer cleared." — all text is removed
You: "Undo"
  → TTS: "Undo" — restores the cleared text
```

---

### 📋 Review Commands

Review your work, read questions and answers aloud, save progress, and manage the review flag.

| Command | Aliases | Active Mode | Description |
|---------|---------|-------------|-------------|
| **"Read question"** | "read the question", "read it", "read aloud" | Command | TTS reads the current question text aloud |
| **"Repeat question"** | "repeat the question", "say again", "read again" | Command | Read the current question aloud again |
| **"Read answer"** | "read my answer", "read back answer", "read response" | Command, Paused | TTS reads your current answer aloud so you can review it |
| **"Save answer"** | "save my answer", "save response", "save it" | Command | Persist the current answer to the database |
| **"Mark for review"** | "mark this question", "flag for review", "mark review" | Command | Flag the current question for later review (updates the palette) |
| **"Unmark review"** | "unmark this question", "remove flag" | Command | Remove the review flag from the current question |

**Usage example — Reviewing before submission:**
```
You: "Read question"
  → TTS: "Question 5. Explain the process of photosynthesis."
You: "Read answer"
  → TTS: "Your answer reads: Photosynthesis is the process by which..."
You: "Mark for review"
  → TTS: "Marked for review" — palette updates to purple
You: "Save answer"
  → TTS: "Answer saved."
You: "Next question"
  → Navigates to Q6
```

---

### 📤 Submission Commands

Submit the exam with a two-step voice confirmation to prevent accidental submission.

| Command | Aliases | Active Mode | Description |
|---------|---------|-------------|-------------|
| **"Submit exam"** | "submit examination", "submit my exam", "finish exam", "end exam", "submit test" | Command | Opens the submission confirmation dialog with a summary of answered/unanswered questions |
| **"Confirm submit"** | "yes submit", "confirm", "yes confirm", "confirm submission" | Confirming | Finalizes and submits the examination — this cannot be undone |
| **"Cancel"** | "go back", "never mind", "cancel submit", "no", "cancel submission" | Confirming | Cancels the submission and returns to the exam |

**Usage example — Submitting the exam:**
```
You: "Submit exam"
  → TTS: "You are about to submit your examination. Say confirm submit to finalize, or cancel to return."
  → Confirmation dialog appears showing: 18 answered, 2 not answered, 0 marked for review
You: "Confirm submit"
  → Exam is submitted, answers are locked
```

**Usage example — Changing your mind:**
```
You: "Submit exam"
  → Confirmation dialog appears
You: "Cancel"
  → TTS: "Cancelled." — returns to the exam
```

---

### ❓ Help Commands

Access the voice command reference at any time without interrupting your exam or recording state.

| Command | Aliases | Active Mode | Description |
|---------|---------|-------------|-------------|
| **"View commands"** | "show commands", "help", "voice help", "list commands" | Command, Paused | Opens the Voice Command Reference modal showing all commands organized by category |
| **"Close commands"** | "hide commands", "close help", "dismiss commands" | Command, Paused | Closes the Voice Command Reference modal |
| **"Read commands"** | "speak commands", "read help" | Command, Paused | TTS reads all available voice commands aloud, organized by category |

**Usage example:**
```
You: "Help"
  → TTS: "Showing voice commands" — modal opens with all 26 commands
You: "Read commands"
  → TTS reads through every command: "Recording commands. Say 'start recording' to begin dictating your answer..."
You: "Close commands"
  → TTS: "Commands closed" — modal closes
```

> You can also click the **"🗣️ View Commands"** button in the accessibility bar to open the reference.

---

### Command Matching & Aliases

All commands use **fuzzy matching** powered by Levenshtein distance. This means:

- **Mispronunciations are tolerated**: "stopp recording" → matches "stop recording"
- **STT errors are handled**: "stob recording" → matches "stop recording"
- **Multiple aliases per command**: "go back", "previous", "last question" all trigger Previous Question
- **Confidence threshold**: Commands require ≥70% match confidence to trigger
- **Debouncing**: The same command won't fire twice within 1.5 seconds

### Command Detection During Dictation

A common issue with voice-command-enabled dictation is commands "leaking" into the answer text. FairScribe solves this with a **dual-layer detection system**:

1. **Pre-filter**: Before any transcript text is appended to the answer, it is checked against all dictation-active commands. If it matches, the text is silently discarded.
2. **Post-filter**: Any residual command phrases that slip through are stripped using a sliding-window fuzzy match.

This ensures that saying "stop recording" during dictation will **never** appear as answer text.

## Quick Start

### Prerequisites

- **Node.js 20+** (LTS recommended)
- **Python 3.9+** (for STT service)
- Windows 10/11 (primary target)

### 1. Install Node dependencies

```bash
npm install
```

> ⚠️ **If you see `NODE_MODULE_VERSION mismatch` errors**, run:
> ```bash
> npx @electron/rebuild -f -w better-sqlite3
> ```

### 2. Set up STT service

```bash
cd stt-service
pip install -r requirements.txt
```

Download required models into `stt-service/models/`:
- **Vosk**: `vosk-model-small-en-in-0.4` (or equivalent)
- **Silero VAD**: `silero_vad.onnx` (auto-downloaded on first run)
- **Whisper**: `base.en` CTranslate2 model

### 3. Start STT service

```bash
cd stt-service
python run.py
```

The service starts on `http://127.0.0.1:5400`. Verify with:
```bash
curl http://127.0.0.1:5400/api/health
```

### 4. Seed the database

```bash
npm run seed
```

Test credentials:
```
Invigilator PIN: 0000

studentId: STU-2024-001  accessCode: arjun2024
studentId: STU-2024-002  accessCode: priya2024
studentId: STU-2024-003  accessCode: rohan2024
```

### 5. Run in development

```bash
npm run dev
```

This starts:
1. Vite dev server on `http://localhost:5173` (React renderer)
2. Electron (waits for Vite, then loads the URL)

---

## Application Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Invigilator Unlock                                           │
│    Enter PIN → Unlock terminal                                  │
├─────────────────────────────────────────────────────────────────┤
│ 2. Student Login                                                │
│    Enter Student ID + Access Code → Kiosk mode activates        │
├─────────────────────────────────────────────────────────────────┤
│ 3. Instructions Screen                                          │
│    Read instructions → Acknowledge → DB initializes answers     │
├─────────────────────────────────────────────────────────────────┤
│ 4. Exam Screen (Voice-Controlled)                               │
│    ┌───────────────────────┬────────────────┐                   │
│    │  Voice Status Bar     │  (mode, hints)  │                  │
│    ├───────────────────────┴────────────────┤                   │
│    │  Question Panel       │  Question      │                   │
│    │  - Question text      │  Palette       │                   │
│    │  - Dictation Panel    │  - Section tabs │                  │
│    │  (voice-controllable) │  - Status grid  │                  │
│    ├───────────────────────┤  - Legend       │                  │
│    │  Action Buttons       │  - Summary     │                   │
│    └───────────────────────┴────────────────┘                   │
│                                                                  │
│    Voice Flow:                                                   │
│    "Start recording" → Dictate answer → "Stop recording"        │
│    "Next question" → Auto-save + navigate → "Read question"     │
│    "Submit exam" → "Confirm submit"                             │
├─────────────────────────────────────────────────────────────────┤
│ 5. Submission                                                    │
│    Review summary → Confirm → Exam finalized                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Demo Flow

| Step | Action | Expected |
|------|--------|----------|
| 1 | Launch app | Invigilator Unlock screen (windowed) |
| 2 | Enter PIN `0000` | Login screen appears |
| 3 | Enter `STU-2024-001` / `arjun2024` | Kiosk mode activates; instructions screen |
| 4 | Acknowledge instructions | Exam loads; voice engine auto-starts |
| 5 | Say "Start recording" | Dictation begins (🔴 Recording indicator) |
| 6 | Speak your answer | Live transcript appears |
| 7 | Say "Stop recording" | Whisper verification runs; mode returns to Command |
| 8 | Say "Next question" | Auto-save → navigate forward |
| 9 | Say "Read question" | TTS reads question aloud |
| 10 | Click `A+` / `A-` | Question text scales up/down |
| 11 | Click `◑ High Contrast` | UI switches to high-contrast |
| 12 | Say "Submit exam" | Confirmation prompt (voice + visual) |
| 13 | Say "Confirm submit" | Exam submitted |
| 14 | `npm run verify-audit` | Chain valid ✅ |

---

## Project Structure

```
fairscribe/
├── electron/
│   ├── main.ts              # Main process, IPC handlers, kiosk activation
│   ├── preload.ts           # contextBridge API for renderer
│   ├── config.ts            # Demo PIN, dev server URL
│   ├── db/
│   │   ├── db.ts            # sql.js connection, query helpers, audit verification
│   │   └── schema.sql       # Table definitions (Student, Exam, AuditLog, Answer)
│   └── stt/
│       └── stt-bridge.ts    # HTTP/WebSocket bridge to Python STT service
├── src/
│   ├── App.tsx              # Screen router
│   ├── screens/
│   │   ├── InvigilatorUnlock.tsx   # Phase 1: Invigilator PIN gate
│   │   ├── Login.tsx               # Phase 1: Student authentication
│   │   ├── Instructions.tsx        # Phase 1: Exam instructions + DB init
│   │   └── QuestionPaper.tsx       # Phase 2–4: Exam UI + voice integration
│   ├── components/
│   │   ├── Timer.tsx               # Countdown timer
│   │   ├── QuestionNav.tsx         # Previous/Next navigation
│   │   ├── QuestionPalette.tsx     # Right panel: section tabs + status grid
│   │   ├── AccessibilityControls.tsx # Zoom + high contrast toggles
│   │   ├── DictationPanel.tsx      # Phase 3: Audio capture + STT transcript
│   │   ├── VoiceCommandStatus.tsx  # Phase 4: Voice mode status bar
│   │   └── ErrorBoundary.tsx       # React error boundary
│   ├── voice/                      # Phase 4: Voice command system
│   │   ├── commandMatcher.ts       # Fuzzy command matching (Levenshtein)
│   │   ├── ttsService.ts           # Offline TTS via speechSynthesis
│   │   ├── VoiceCommandEngine.ts   # Command engine (mic capture + matching)
│   │   └── useVoiceCommandEngine.ts # React hook (state machine + actions)
│   ├── state/
│   │   └── examSession.tsx         # React context for session data
│   ├── styles/
│   │   ├── global.css              # Design tokens + high-contrast theme
│   │   ├── InvigilatorUnlock.module.css
│   │   ├── Login.module.css
│   │   ├── Instructions.module.css
│   │   ├── QuestionPaper.module.css
│   │   ├── QuestionPalette.module.css
│   │   ├── Dictation.module.css
│   │   ├── VoiceCommandStatus.module.css
│   │   ├── Submit.module.css
│   │   └── components.module.css
│   └── types/
│       └── fairscribe.d.ts         # Global type declarations
├── stt-service/                    # Python STT backend (Phase 3)
│   ├── stt_service/
│   │   ├── app.py                  # FastAPI application factory
│   │   ├── config.py               # Settings loader
│   │   ├── engine/
│   │   │   ├── vosk_engine.py      # Vosk streaming recognition
│   │   │   ├── whisper_engine.py   # Faster-Whisper verification
│   │   │   ├── vad.py              # Silero VAD
│   │   │   └── audio_processor.py  # Audio processing utilities
│   │   ├── session/
│   │   │   ├── manager.py          # Session lifecycle management
│   │   │   └── state.py            # Session state machine
│   │   └── routes/
│   │       ├── health.py           # GET /api/health
│   │       ├── sessions.py         # POST/DELETE /api/sessions
│   │       └── streaming.py        # WS /api/sessions/{id}/stream
│   └── config.yaml                 # STT service configuration
├── public/
│   └── pcm-processor.js            # AudioWorklet processor (mic capture)
├── data/
│   ├── sample-exam.json            # Sample exam paper (5 questions)
│   └── seed-students.json          # Test student credentials
├── scripts/
│   ├── seed.ts                     # npm run seed
│   └── verify-audit.ts             # npm run verify-audit
└── index.html
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     React Renderer                            │
│                                                               │
│  ┌─────────────────────┐  ┌─────────────────────────┐       │
│  │  QuestionPaper.tsx   │  │  VoiceCommandEngine.ts   │       │
│  │  (exam UI + voice    │  │  (command STT session    │       │
│  │   engine hook)       │←─│   + fuzzy matching)      │       │
│  ├─────────────────────┤  └──────────┬──────────────┘       │
│  │  DictationPanel.tsx  │             │                       │
│  │  (answer STT session │             │                       │
│  │   + AudioWorklet)    │             │                       │
│  └──────────┬──────────┘  ┌──────────┴──────────────┐       │
│             │              │  ttsService.ts           │       │
│             │              │  (speechSynthesis API)   │       │
│             │              └─────────────────────────┘       │
└─────────────┼────────────────────────────────────────────────┘
              │ IPC (contextBridge)
┌─────────────┼────────────────────────────────────────────────┐
│  Electron Main Process                                        │
│  ┌──────────┴──────────┐  ┌─────────────────────────┐       │
│  │  stt-bridge.ts       │  │  db.ts (sql.js/WASM)    │       │
│  │  (HTTP + WebSocket   │  │  (in-memory → disk)     │       │
│  │   to Python service) │  │                          │       │
│  └──────────┬──────────┘  └─────────────────────────┘       │
└─────────────┼────────────────────────────────────────────────┘
              │ HTTP/WebSocket (localhost:5400)
┌─────────────┼────────────────────────────────────────────────┐
│  Python STT Service (FastAPI)                                 │
│  ┌──────────┴──────────┐                                     │
│  │  Vosk Engine         │ ← Real-time streaming recognition  │
│  │  Silero VAD          │ ← Voice activity detection         │
│  │  Faster-Whisper      │ ← Post-recording verification     │
│  └─────────────────────┘                                     │
│  100% offline — no internet required                          │
└──────────────────────────────────────────────────────────────┘
```

---

## Voice Command System Architecture

The voice command system runs **entirely in the renderer process** and uses the **same Python STT pipeline** as dictation. Key design:

1. **Separate STT sessions**: The voice command engine creates its own STT session for command detection, independent of DictationPanel's session. Both connect to the same Python Vosk instance. *(Note: The STT backend must be configured with `max_concurrent: 2` or higher in `config.yaml` to support both sessions simultaneously).*

2. **Fuzzy matching**: Commands are matched using Levenshtein distance with configurable thresholds. This handles common STT errors ("stopp recording" → "stop recording").

3. **Mode-aware activation**: Each command specifies which modes it's active in. "Start recording" only works in Command Mode; "Stop recording" only works during dictation.

4. **Debouncing**: A 1.5s debounce prevents the same command from firing twice.

5. **Offline TTS**: System announcements use the browser's `speechSynthesis` API with Microsoft offline voices (pre-installed on Windows 10/11).

---

## Accessibility Features

- **Zoom**: Font scaling from 80% to 200% in 10% steps
- **High Contrast**: WCAG AAA compliant black/white colour scheme
- **Voice Control**: Fully hands-free operation — no mouse/keyboard needed
- **TTS**: Questions read aloud on demand ("Read question" command)
- **ARIA Labels**: All interactive elements have descriptive labels
- **Focus Management**: Keyboard-navigable interface
- **Screen Reader**: ARIA live regions announce mode changes and command feedback

---

## Known Limitations

### 1. Kiosk lockdown is best-effort on Windows

`globalShortcut` in Electron can intercept most application-level shortcuts but **cannot block OS-level sequences** (Alt+Tab, Windows key, Ctrl+Alt+Del). Full lockdown requires Group Policy or a kiosk OS.

### 2. `accessCode` stored as plaintext

Prototype simplification. Production requires salted hashes (Argon2/bcrypt).

### 3. Invigilator PIN is hardcoded

`INVIGILATOR_PIN = "0000"` in `electron/config.ts`. Must be per-session issued in production.

### 4. Timer has no auto-submit

Countdown is display-only. Auto-submit is a Phase 5 deliverable.

### 5. Single exam session per DB seeding

Dev database holds one exam and three students.

### 6. Voice command recognition depends on ambient noise

In noisy environments, command recognition accuracy may decrease. The fuzzy matching threshold (0.72) balances tolerance with false positive prevention.

### 7. TTS requires Windows offline voices

The `speechSynthesis` API uses Microsoft David/Zira voices pre-installed on Windows 10/11. On systems without offline voices, TTS announcements will be silent but the exam flow continues normally.

---

## Troubleshooting

### `NODE_MODULE_VERSION mismatch`

```bash
npx @electron/rebuild -f -w better-sqlite3
```

### App shows blank screen

Check Vite terminal for the actual port. Ensure it matches `VITE_DEV_SERVER_URL` in `electron/config.ts`.

### Voice commands not working or "stop recording" is ignored

1. Ensure STT service is running: `curl http://127.0.0.1:5400/api/health`
2. Check browser console for `[VoiceEngine]` logs
3. Ensure microphone permission is granted
4. Check that a Vosk model is loaded
5. **If "start recording" works but "stop recording" is ignored:** Ensure `stt-service/config.yaml` has `max_concurrent` set to at least `2`. If it is set to `1`, the backend will kill the command engine's background session when dictation starts.

### TTS not speaking

1. Check `window.speechSynthesis.getVoices()` in browser console
2. Ensure offline voices are installed (Windows Settings → Time & Language → Speech)

### STT service won't start

1. Verify Python dependencies: `pip install -r requirements.txt`
2. Ensure Vosk model exists at the path in `config.yaml`
3. Check port 5400 is not in use

---

## Phases Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1–2 | ✅ **Complete** | Auth gates, kiosk activation, question paper rendering, audit log |
| 3 | ✅ **Complete** | Vosk real-time STT, Whisper verification, Silero VAD, DictationPanel |
| 4 | ✅ **Complete** | Voice command engine, fuzzy matching, TTS, hands-free navigation |
| 5 | ⏳ Planned | Submission, PDF watermarking, answer encryption, autosave, watchdog |
| 6 | ⏳ Planned | Post-exam invigilator-authorized sync to exam server |

---

## Prerequisites
Before running FairScribe, please ensure you have the following installed on your machine:
1. **Node.js** (v18 or higher recommended)
2. **Python** (v3.10 or higher recommended)
3. **Git**

## Setup Instructions

### 1. Clone the repository
Open your terminal or command prompt and run:
```bash
git clone <URL_OF_THE_GITHUB_REPO>
cd FairScribe
```

### 2. Set up the Speech-to-Text (STT) Backend
The STT service runs entirely offline using Python. 

1. Open a terminal and navigate to the backend folder:
   ```bash
   cd stt-service
   ```
2. Create a virtual environment:
   ```bash
   # On Windows
   python -m venv venv
   venv\Scripts\activate
   
   # On Mac/Linux
   python3 -m venv venv
   source venv/bin/activate
   ```
3. Install the required Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. **Important - Download the Model:** Ensure that the required offline Speech-to-Text models are placed in the `stt-service/models/` folder as specified in `stt-service/config.yaml` (e.g., `vosk-model-small-en-in-0.4`).
5. Start the backend server:
   ```bash
   python run.py
   ```
   *(Keep this terminal window running in the background).*

### 3. Set up the Electron / React Frontend
Open a **new** terminal window and make sure you are in the root `FairScribe` directory.

1. Install the Node.js dependencies:
   ```bash
   npm install
   ```
2. (Optional) If the database needs to be seeded with initial exam data:
   ```bash
   npm run seed
   ```
3. Start the application:
   ```bash
   npm run dev
   ```
The FairScribe app should now launch in a new window, automatically connecting to the offline STT backend!
