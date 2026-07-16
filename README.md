# FairScribe

**Secure offline speech-to-text examination terminal** — a digital alternative to human scribes for candidates with motor/physical disabilities.

> **Phase 1–2 build** — Authentication (Invigilator Unlock + Student Login) and Question Paper Rendering. Speech-to-text dictation arrives in Phase 3.

---

## Quick Start

### Prerequisites

- **Node.js 20+** (LTS recommended)
- **Python 3.9+** (for Phase 3 STT service — not needed yet)
- Windows 10/11 (primary target; macOS works with kiosk caveats noted below)

### 1. Install dependencies

```bash
npm install
```

> ⚠️ **If you see `NODE_MODULE_VERSION mismatch` errors**, run:
> ```bash
> npx @electron/rebuild -f -w better-sqlite3
> ```
> This is the **#1 first-run failure** on this stack. `better-sqlite3` is a native addon compiled against a specific Node ABI, and Electron ships its own Node runtime with a different ABI. `npm install` runs `electron-rebuild` automatically via `postinstall`, but on some setups it needs to be triggered manually. See [Troubleshooting](#troubleshooting).

### 2. Seed the database

```bash
npm run seed
```

Creates `fairscribe.db` in the project root (development only — in production, the DB lives in Electron's `userData` path).

Prints the test credentials:
```
✓ Student seeded: STU-2024-001 — Arjun Mehta [motor_impairment]
✓ Student seeded: STU-2024-002 — Priya Nair [cerebral_palsy]
✓ Student seeded: STU-2024-003 — Rohan Sharma [muscular_dystrophy]

Test credentials:
  studentId: STU-2024-001  accessCode: arjun2024
  studentId: STU-2024-002  accessCode: priya2024
  studentId: STU-2024-003  accessCode: rohan2024
```

### 3. Run in development

```bash
npm run dev
```

This starts:
1. Vite dev server on `http://localhost:5173` (React renderer)
2. Electron (waits for Vite to be ready via `wait-on`, then loads the URL)

The app opens to the **Invigilator Unlock** screen (not fullscreen yet).

> **If the app loads a blank screen:** Vite's `strictPort: true` means it will _fail_ rather than silently bump to port 5174 — check the Vite terminal output for the actual port, and confirm it matches the `VITE_DEV_SERVER_URL` in `electron/config.ts`.

### 4. Verify the audit chain

After running through the auth flow and navigating a few questions:

```bash
npm run verify-audit
```

Output (success):
```
Verifying audit chain (4 entries)...

  [0001] ✓ db_seeded                        2024-01-15T09:00:00.000Z
  [0002] ✓ login_success                    2024-01-15T09:05:12.342Z
  [0003] ✓ question_paper_loaded            2024-01-15T09:05:12.891Z
  [0004] ✓ question_navigated               2024-01-15T09:06:45.210Z

✅ Audit chain VALID — 4 entries verified.
```

---

## Demo Flow

| Step | Action | Expected |
|------|--------|---------|
| 1 | Launch app | Invigilator Unlock screen (windowed) |
| 2 | Enter PIN `0000` | Login screen appears |
| 3 | Enter `STU-2024-001` / `arjun2024` | Kiosk mode activates; question paper loads |
| 4 | Navigate questions | Prev/Next/jump buttons work; each writes AuditLog |
| 5 | Click `A+` / `A-` | Question text scales up/down |
| 6 | Click `◑ High Contrast` | UI switches to high-contrast colour scheme |
| 7 | Watch timer | Counts down from 2:00:00 |
| 8 | `npm run verify-audit` | Chain valid ✅ |

---

## Project Structure

```
fairscribe/
├── electron/
│   ├── main.ts              # Main process, IPC handlers, kiosk activation
│   ├── preload.ts           # contextBridge API for renderer
│   ├── config.ts            # Demo PIN, dev server URL
│   └── db/
│       ├── db.ts            # SQLite connection, query helpers, verifyAuditChain()
│       └── schema.sql       # Table definitions (Student, Exam, AuditLog)
├── src/
│   ├── App.tsx              # Screen router
│   ├── screens/
│   │   ├── InvigilatorUnlock.tsx
│   │   ├── Login.tsx
│   │   └── QuestionPaper.tsx
│   ├── components/
│   │   ├── Timer.tsx
│   │   ├── QuestionNav.tsx
│   │   └── AccessibilityControls.tsx
│   ├── state/
│   │   └── examSession.ts   # React context for session data
│   ├── styles/
│   │   ├── global.css       # Design tokens + high-contrast theme
│   │   ├── InvigilatorUnlock.module.css
│   │   ├── Login.module.css
│   │   ├── QuestionPaper.module.css
│   │   └── components.module.css
│   └── types/
│       └── fairscribe.d.ts  # window.fairscribe API types
├── data/
│   ├── seed-students.json
│   └── sample-exam.json
├── scripts/
│   ├── seed.ts              # `npm run seed`
│   └── verify-audit.ts      # `npm run verify-audit`
└── index.html
```

---

## Known Limitations (Phase 1–2)

These are documented design constraints, not silent gaps. All are acknowledged in the FairScribe research paper as prototype boundaries.

### 1. Kiosk lockdown is best-effort on Windows

`globalShortcut` in Electron can intercept most application-level shortcuts (Alt+F4, F12, Ctrl+Shift+I, etc.), but **cannot block OS-level interrupt sequences**:

- **Alt+Tab** — managed by the Windows OS scheduler; cannot be blocked by a userspace application without elevated hooks or Shell replacement.
- **Windows key** — similarly OS-managed.
- **Ctrl+Alt+Del** — hardwired in the Windows kernel; unreachable by any userspace process.

Full lockdown would require Group Policy configuration, a custom Windows Shell replacement, or a purpose-built kiosk OS (e.g., ChromeOS Kiosk, or a locked-down Windows IoT image with MDM). This is documented as future work in the paper.

### 2. `accessCode` stored as plaintext

The `Student.accessCode` column contains the raw access code string. This is a **prototype simplification only**. In production:
- Codes must be stored as salted hashes (e.g., Argon2 or bcrypt).
- Comparison must be constant-time to prevent timing attacks.

The schema comment and `db.ts` both flag this explicitly.

### 3. Invigilator PIN is hardcoded

`INVIGILATOR_PIN = "0000"` in `electron/config.ts`. In a real deployment, the PIN would be issued per session by the exam authority and never hardcoded. Change this before any live use.

### 4. No speech-to-text yet (Phase 3)

The answer editor panel on the Question Paper screen is a labeled placeholder. The Vosk real-time STT integration and Whisper verification pipeline are Phase 3 deliverables.

### 5. Timer has no auto-submit

The countdown timer in `Timer.tsx` is display-only. When it reaches 00:00:00, it holds there. Auto-submit behavior (locking the editor, writing a `time_expired` audit entry, initiating submission) is a Phase 5 deliverable.

### 6. Single exam session per DB seeding

The dev database holds one exam (`EXAM001`) and three students. Multi-exam and multi-center orchestration is out of scope for the prototype.

### 7. macOS kiosk behavior

`setKiosk(true)` on an existing window interacts with macOS native fullscreen spaces and may behave differently than on Windows. Since Windows is the primary exam-center target OS, macOS behavior is best-effort only.

---

## Troubleshooting

### `NODE_MODULE_VERSION mismatch` / `was compiled against a different Node.js version`

```bash
npx @electron/rebuild -f -w better-sqlite3
```

This recompiles `better-sqlite3` against Electron's bundled Node headers. Run it whenever you update the `electron` package version or switch Node.js versions.

### App launches but shows blank screen

Check the Vite terminal output for the actual dev server port. `vite.config.ts` uses `strictPort: true`, which means Vite will fail if port 5173 is taken rather than silently moving to 5174 — but if for any reason it starts on a different port, the `VITE_DEV_SERVER_URL` in `electron/config.ts` must match.

### `npm run seed` fails with `no such file: fairscribe.db`

The DB file is created automatically by the seed script — if it fails, check that the project root is writable and that `better-sqlite3` was successfully rebuilt (see above).

### `npm run verify-audit` says `Could not open database`

Run `npm run seed` first to create and populate the database. The verify script opens it read-only and will fail if the file doesn't exist.

---

## Phases Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1–2 | ✅ **Complete** | Auth gates, kiosk activation, question paper rendering, audit log |
| 3 | 🔜 Next | Vosk real-time STT, Whisper verification, answer editor (Slate.js), voice commands |
| 4 | ⏳ Planned | Voice command grammar (rule-based, no LLM) |
| 5 | ⏳ Planned | Submission, PDF watermarking, answer encryption, autosave, watchdog |
| 6 | ⏳ Planned | Post-exam invigilator-authorized sync to exam server |
