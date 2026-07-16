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
    // Open DevTools in dev mode — closed automatically when kiosk activates
    mainWindow.webContents.openDevTools();
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

  // Register global shortcuts to intercept/block common escape routes.
  // These operate at the Electron application level — see KNOWN LIMITATION above.
  const blockedShortcuts = [
    'Alt+F4',       // Close window
    'Escape',       // Common "back" / fullscreen-exit
    'F11',          // Toggle fullscreen in many apps
    'Ctrl+Shift+I', // Chrome devtools
    'Ctrl+Shift+J', // Chrome devtools (console)
    'F12',          // Devtools
    'Ctrl+R',       // Reload
    'Ctrl+Shift+R', // Hard reload
    'Ctrl+W',       // Close tab
    'Ctrl+N',       // New window
    'Ctrl+T',       // New tab
    'Alt+Left',     // Browser back
    'Alt+Right',    // Browser forward
  ];

  for (const shortcut of blockedShortcuts) {
    globalShortcut.register(shortcut, () => {
      // Swallow the shortcut — do nothing.
      // Logging suppressed to avoid spamming the audit log with keypress noise.
    });
  }

  // NOTE: Alt+Tab is handled at the OS level (process scheduling) and cannot
  // be reliably intercepted by globalShortcut on Windows. It is registered
  // here as best-effort but will not block OS-native window switching.
  globalShortcut.register('Alt+Tab', () => { /* swallowed */ });

  // ── Best-effort Alt+Tab mitigation ──
  // 'screen-saver' is the highest z-order level available in Electron.
  // On most Windows configurations this keeps the window above the Alt+Tab
  // switcher overlay, effectively preventing visual app switching.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // If focus is somehow lost (e.g. via an OS notification or accessibility
  // tool), aggressively reclaim it. This is a best-effort measure — it
  // cannot prevent the OS from forcibly focusing another window (e.g.
  // Ctrl+Alt+Del → Task Manager).
  mainWindow.on('blur', () => {
    if (mainWindow && mainWindow.isKiosk()) {
      // Small delay to avoid fighting with OS focus transitions
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.focus();
          mainWindow.moveTop();
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
