import { app, BrowserWindow, ipcMain, globalShortcut, Menu } from 'electron';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';

import { INVIGILATOR_PIN, VITE_DEV_SERVER_URL } from './config';
import {
  initDb,
  getStudentByCredentials,
  getExam,
  updateExamHash,
  insertAuditLog,
  verifyAuditChain,
  initAnswers,
  upsertAnswerStatus,
  getAnswerStatuses,
} from './db/db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const isDev = process.env.NODE_ENV === 'development';

// Path to the bundled question paper JSON
const QUESTION_PAPER_PATH = isDev
  ? path.join(__dirname, '../../data/sample-exam.json')
  : path.join(process.resourcesPath, 'data/sample-exam.json');

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  // Eliminate the application menu entirely before any window is shown.
  // This removes File/Edit/View menus and their keyboard shortcuts.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // Start in NON-kiosk mode — the Invigilator Unlock screen runs here.
    // Kiosk mode is activated in-place via 'kiosk:activate' IPC after
    // successful student login (see handleKioskActivate below).
    kiosk: false,
    fullscreen: false,
    autoHideMenuBar: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security: disable Node integration in renderer — all main-process
      // access goes through the contextBridge API in preload.ts
      nodeIntegration: false,
      contextIsolation: true,
      // Disable remote module (deprecated and a security risk)
      // Devtools are accessible in dev mode only
      devTools: isDev,
    },
  });

  // Load the renderer
  if (isDev) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    globalShortcut.unregisterAll();
  });
}


// ---------------------------------------------------------------------------
// Kiosk mode activation
// ---------------------------------------------------------------------------

/**
 * Reconfigures the existing BrowserWindow into kiosk mode.
 *
 * DESIGN NOTE: We reconfigure in place rather than recreating the window.
 * This preserves the renderer process and its React state (session context,
 * student data, etc.) — no need to re-fetch everything from the DB.
 *
 * TARGET PLATFORM: Windows (Electron 28+). setKiosk(true) on an existing
 * window is reliable on this platform. macOS kiosk behavior may differ
 * (native fullscreen spaces interaction) — treat as best-effort on macOS.
 *
 * KNOWN LIMITATION: globalShortcut can intercept most keyboard shortcuts
 * at the Electron level, but it CANNOT block OS-level interrupt sequences
 * like Windows key, Ctrl+Alt+Del, or hardware-level app switching (Alt+Tab
 * at the OS scheduler level). Full OS-level lockdown would require:
 *   - Custom Windows Shell replacement, or
 *   - Group Policy / MDM configuration on managed exam devices, or
 *   - A purpose-built kiosk OS.
 * This is a documented limitation of the prototype, not a silent gap.
 * See README §Known Limitations.
 */
function activateKioskMode(): void {
  if (!mainWindow) return;

  // Close DevTools if open in dev mode
  if (isDev && mainWindow.webContents.isDevToolsOpened()) {
    mainWindow.webContents.closeDevTools();
  }

  mainWindow.setKiosk(true);
  mainWindow.setFullScreen(true);
  mainWindow.setMenuBarVisibility(false);

  // Close DevTools if they were open (e.g. left open during dev testing)
  if (mainWindow.webContents.isDevToolsOpened()) {
    mainWindow.webContents.closeDevTools();
  }

  // ---------------------------------------------------------------------------
  // Comprehensive shortcut blocking
  // ---------------------------------------------------------------------------
  // globalShortcut hooks at the keyboard driver level (before the OS processes
  // most keys), so many Win+key combos CAN be intercepted here.
  // Exceptions: Ctrl+Alt+Del (firmware-level), Win+L (OS security feature).
  // ---------------------------------------------------------------------------

  const blockedShortcuts: string[] = [
    // ── Window / app escapes ──
    'Alt+F4',           // Close window
    'F11',              // Toggle fullscreen
    'Escape',           // Back / fullscreen exit

    // ── Alt combos ──
    'Alt+Tab',          // Switch app (best-effort — OS controls this)
    'Alt+Escape',       // Cycle windows
    'Alt+Space',        // Window menu

    // ── Ctrl+Esc / Start Menu ──
    'Ctrl+Escape',      // Open Start Menu

    // ── Task Manager ──
    'Ctrl+Shift+Escape', // Task Manager

    // ── DevTools / reload ──
    'Ctrl+Shift+I',
    'Ctrl+Shift+J',
    'F12',
    'Ctrl+R',
    'Ctrl+Shift+R',

    // ── Browser navigation shortcuts ──
    'Ctrl+W',           // Close tab
    'Ctrl+N',           // New window
    'Ctrl+T',           // New tab
    'Ctrl+Shift+T',     // Restore tab
    'Ctrl+L',           // Address bar
    'Ctrl+H',           // History
    'Ctrl+J',           // Downloads
    'Ctrl+U',           // View source
    'Ctrl+P',           // Print
    'Ctrl+O',           // Open file
    'Ctrl+F',           // Find
    'Alt+Left',         // Back
    'Alt+Right',        // Forward

    // ── Clipboard / edit (renderer will still handle these, but block OS-global) ──
    'Ctrl+X',
    'Ctrl+C',
    'Ctrl+V',
    'Ctrl+A',
    'Ctrl+Z',
    'Ctrl+Y',

    // ── Screenshot ──
    'PrintScreen',
    'Shift+PrintScreen',

    // ── Win key combos ──
    // (Electron's globalShortcut CAN intercept many of these before Shell sees them)
    'Super+D',          // Show Desktop
    'Super+M',          // Minimize All
    'Super+Shift+M',    // Restore Windows
    'Super+E',          // File Explorer
    'Super+R',          // Run Dialog
    'Super+X',          // Power User Menu
    'Super+I',          // Settings
    'Super+S',          // Search
    'Super+V',          // Clipboard History
    'Super+G',          // Xbox Game Bar
    'Super+P',          // Projection
    'Super+K',          // Connect Devices
    'Super+A',          // Quick Settings
    'Super+N',          // Notifications
    'Super+Tab',        // Task View
    'Super+Shift+S',    // Snipping Tool
    'Super+PrintScreen',// Screenshot to Pictures
    'Super+Up',         // Snap Maximize
    'Super+Down',       // Snap Restore/Minimize
    'Super+Left',       // Snap Left
    'Super+Right',      // Snap Right
    'Super+H',          // Cortana / Voice
    'Super+Q',          // Search
    'Super+W',          // Widgets
    'Super+Z',          // Snap Layout
    'Super+Comma',      // Peek Desktop
    'Super+Period',     // Emoji Picker
  ];

  // Register all — failures are silently ignored (some combos may be uncapturable)
  for (const shortcut of blockedShortcuts) {
    try {
      globalShortcut.register(shortcut, () => { /* swallowed */ });
    } catch {
      // Shortcut not supported on this platform — skip silently
    }
  }

  // ---------------------------------------------------------------------------
  // Renderer-level: block browser shortcuts via before-input-event
  // This catches keys that hit the WebContents AFTER the OS, covering any
  // gaps in globalShortcut (e.g. Ctrl+C within the page context).
  // ---------------------------------------------------------------------------
  if (mainWindow) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      // Block all Ctrl+key combos except Ctrl+A/Z/Y which may be useful in editor
      const ctrl = input.control;
      const key  = input.key.toLowerCase();

      const browserBlockList = ['p', 'o', 'n', 't', 'w', 'h', 'j', 'u', 'f',
                                'l', 'r', 'shift+r'];
      if (ctrl && browserBlockList.includes(key)) {
        _event.preventDefault();
      }

      // Block PrintScreen at renderer level too
      if (input.key === 'PrintScreen') {
        _event.preventDefault();
      }

      // Block F1–F12 except F5 (page reload already blocked via globalShortcut)
      if (['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12']
          .includes(input.key)) {
        _event.preventDefault();
      }
    });
  }

  // ── Best-effort Alt+Tab mitigation ──
  // 'screen-saver' is the highest z-order level available in Electron.
  // On most Windows configurations this keeps the window above the Alt+Tab
  // switcher overlay, effectively preventing visual app switching.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // ── Win+D / Win+M mitigation ──
  // These shortcuts are processed by the Windows shell (explorer.exe) BEFORE
  // Electron's globalShortcut hook sees them, so they cannot be intercepted.
  // Instead, we listen for the 'minimize' event and immediately restore + refocus.
  mainWindow.on('minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isKiosk()) {
      setImmediate(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.restore();
          mainWindow.focus();
          mainWindow.moveTop();
          mainWindow.setFullScreen(true);
        }
      });
    }
  });

  // If focus is somehow lost (e.g. via an OS notification or accessibility
  // tool), aggressively reclaim it. This is a best-effort measure — it
  // cannot prevent the OS from forcibly focusing another window (e.g.
  // Ctrl+Alt+Del → Task Manager).
  mainWindow.on('blur', () => {
    if (mainWindow && mainWindow.isKiosk()) {
      // Small delay to avoid fighting with OS focus transitions
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          // Restore first in case Win+D/Win+M minimized us
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
          mainWindow.moveTop();
          mainWindow.setFullScreen(true);
        }
      }, 100);
    }
  });
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

/** auth:verifyPin — compare submitted PIN against the prototype config value */
ipcMain.handle('auth:verifyPin', (_event, pin: string): boolean => {
  return pin === INVIGILATOR_PIN;
});

/** auth:login — look up student + exam, write audit log, return session data */
ipcMain.handle(
  'auth:login',
  (_event, studentId: string, accessCode: string) => {
    const student = getStudentByCredentials(studentId, accessCode);

    if (!student) {
      // Log failure WITHOUT including the attempted access code
      insertAuditLog('login_failure', { studentId, reason: 'invalid_credentials' });
      return null;
    }

    const exam = getExam(student.examId);
    if (!exam) {
      insertAuditLog('login_failure', { studentId, reason: 'exam_not_found' });
      return null;
    }

    insertAuditLog('login_success', {
      studentId: student.studentId,
      examId: exam.examId,
    });

    return {
      student: {
        studentId: student.studentId,
        name: student.name,
        examId: student.examId,
        disabilityCategory: student.disabilityCategory,
      },
      exam: {
        examId: exam.examId,
        examTitle: exam.examTitle,
        duration: exam.duration,
        languageConfig: exam.languageConfig,
      },
    };
  }
);

/** exam:loadQuestionPaper — read JSON, hash it, store hash, write audit entry */
ipcMain.handle('exam:loadQuestionPaper', (_event, examId: string) => {
  const raw = fs.readFileSync(QUESTION_PAPER_PATH, 'utf-8');
  const hash = crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');

  // Persist the hash into the Exam row for integrity verification
  updateExamHash(examId, hash);

  insertAuditLog('question_paper_loaded', {
    examId,
    questionPaperHash: hash,
  });

  const data = JSON.parse(raw);
  return { ...data, questionPaperHash: hash };
});

/** exam:submit — record submission in audit log */
ipcMain.handle(
  'exam:submit',
  (_event, examId: string, details: Record<string, unknown>) => {
    insertAuditLog('submission_complete', {
      examId,
      submittedAt: new Date().toISOString(),
      ...details,
    });
  }
);

/**
 * exam:initAnswers — bulk-insert Answer rows with status='not_visited'.
 * Called once when the candidate acknowledges the Instructions screen.
 * Uses INSERT OR IGNORE so crash-recovery re-runs are safe.
 */
ipcMain.handle(
  'exam:initAnswers',
  (_event, questionIds: string[], studentId: string) => {
    initAnswers(questionIds, studentId);
  }
);

/**
 * exam:updateAnswerStatus — persist a single question's status change.
 * Called on every Save & Next / Mark for Review action — never batched.
 * Writes immediately so a crash cannot lose palette state.
 */
ipcMain.handle(
  'exam:updateAnswerStatus',
  (_event, questionId: string, studentId: string, status: string, answerText: string) => {
    upsertAnswerStatus(questionId, studentId, status, answerText);
  }
);

/**
 * exam:getAnswerStatuses — return all Answer rows for a student.
 * Used to rehydrate the in-memory status map from the DB (e.g. after a
 * renderer reload or future crash-recovery flow).
 */
ipcMain.handle(
  'exam:getAnswerStatuses',
  (_event, studentId: string) => {
    return getAnswerStatuses(studentId);
  }
);

/** audit:logEvent — insert a chained audit entry (renderer-triggered events) */
ipcMain.handle(
  'audit:logEvent',
  (_event, eventType: string, deviceState?: Record<string, unknown>) => {
    insertAuditLog(eventType, deviceState);
  }
);

/** audit:verify — run verifyAuditChain and return result */
ipcMain.handle('audit:verify', () => {
  return verifyAuditChain();
});

/** kiosk:activate — switch existing window into kiosk mode in place */
ipcMain.handle('kiosk:activate', () => {
  activateKioskMode();
});

/**
 * kiosk:quit — terminate the app after submission.
 *
 * CRITICAL: Must tear down all kiosk lockdown measures before quitting,
 * otherwise the blur-refocus handler and setAlwaysOnTop fight the quit
 * and can trap the user in a black/unresponsive fullscreen window.
 *
 * Cleanup order:
 *   1. Unregister all global shortcuts (re-enables Alt+F4 as safety net)
 *   2. Remove blur handler (stops auto-refocus from fighting the close)
 *   3. Disable always-on-top (let the window layer go back to normal)
 *   4. Exit kiosk + fullscreen (release the display)
 *   5. Write final audit entry
 *   6. Destroy window + quit app
 */
ipcMain.handle('kiosk:quit', () => {
  // 1. Re-enable all keyboard shortcuts at OS level
  globalShortcut.unregisterAll();

  if (mainWindow && !mainWindow.isDestroyed()) {
    // 2. Remove ALL listeners (including the blur-refocus handler)
    mainWindow.removeAllListeners('blur');

    // 3–4. Tear down kiosk visual lockdown
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setKiosk(false);
    mainWindow.setFullScreen(false);
  }

  // 5. Final audit entry
  insertAuditLog('app_terminated', { reason: 'post_submission_quit' });

  // 6. Close window and quit — small delay to let the audit write flush
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
    app.quit();
  }, 200);
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // Initialise the sql.js WASM engine and open/create the database.
  // Must complete before the window loads, so IPC handlers can use the DB
  // from the first renderer message.
  await initDb();

  createWindow();

  app.on('activate', () => {
    // macOS: re-create window if dock icon is clicked and no windows open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  // On macOS it's conventional to keep the app running — on Windows/Linux, quit.
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
