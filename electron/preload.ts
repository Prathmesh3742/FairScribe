import { contextBridge, ipcRenderer } from 'electron';

/**
 * FairScribe Preload Script
 *
 * Exposes a minimal, typed API surface to the renderer process via
 * contextBridge. The renderer has no direct access to Node.js or
 * Electron internals — only what is explicitly listed here.
 *
 * This is the security boundary between the untrusted renderer and
 * the trusted main process. Keep the exposed surface as narrow as possible.
 */

contextBridge.exposeInMainWorld('fairscribe', {
  // -------------------------------------------------------------------------
  // auth namespace
  // -------------------------------------------------------------------------
  auth: {
    /**
     * Verify the invigilator PIN. Returns true if correct.
     * The actual PIN comparison happens in the main process — the renderer
     * never sees the real PIN value.
     */
    verifyPin: (pin: string): Promise<boolean> =>
      ipcRenderer.invoke('auth:verifyPin', pin),

    /**
     * Attempt student login.
     * On success, the main process writes a login_success AuditLog entry
     * and returns the session payload.
     * On failure, writes login_failure (without the attempted code) and
     * returns null.
     */
    login: (
      studentId: string,
      accessCode: string
    ): Promise<{
      student: {
        studentId: string;
        name: string;
        examId: string;
        disabilityCategory: string | null;
      };
      exam: {
        examId: string;
        examTitle: string;
        duration: number;
        languageConfig: string;
      };
    } | null> => ipcRenderer.invoke('auth:login', studentId, accessCode),
  },

  // -------------------------------------------------------------------------
  // exam namespace
  // -------------------------------------------------------------------------
  exam: {
    /**
     * Load the question paper JSON, compute + store its SHA-256 hash,
     * and write a question_paper_loaded AuditLog entry.
     * Returns the parsed question paper data.
     */
    loadQuestionPaper: (examId: string): Promise<{
      examId: string;
      examTitle: string;
      duration: number;
      questions: Array<{
        questionId: string;
        questionText: string;
        marks: number;
      }>;
      questionPaperHash: string;
    }> => ipcRenderer.invoke('exam:loadQuestionPaper', examId),

    /**
     * Submit the examination. Writes a submission_complete AuditLog entry
     * and locks the session.
     */
    submit: (
      examId: string,
      details: Record<string, unknown>
    ): Promise<void> => ipcRenderer.invoke('exam:submit', examId, details),
  },

  // -------------------------------------------------------------------------
  // audit namespace
  // -------------------------------------------------------------------------
  audit: {
    /**
     * Write a new AuditLog entry, chained from the last.
     * Called from the renderer for UI-driven events like question navigation.
     */
    logEvent: (
      eventType: string,
      deviceState?: Record<string, unknown>
    ): Promise<void> =>
      ipcRenderer.invoke('audit:logEvent', eventType, deviceState),

    /**
     * Run verifyAuditChain() and return the result.
     * Exposed here for the hidden dev IPC path; primarily invoked via
     * `npm run verify-audit` (scripts/verify-audit.ts).
     */
    verify: (): Promise<{ valid: boolean; brokenAt?: number }> =>
      ipcRenderer.invoke('audit:verify'),
  },

  // -------------------------------------------------------------------------
  // kiosk namespace
  // -------------------------------------------------------------------------
  kiosk: {
    /**
     * Signal the main process to activate kiosk mode on the existing window.
     * Called once after successful student login.
     *
     * Main process calls:
     *   mainWindow.setKiosk(true)
     *   mainWindow.setFullScreen(true)
     *   mainWindow.setMenuBarVisibility(false)
     *
     * This reconfigures in place — the renderer process is NOT restarted,
     * so React state (session context) is preserved.
     */
    activate: (): Promise<void> => ipcRenderer.invoke('kiosk:activate'),

    /**
     * Request the app to quit. Called after submission countdown completes.
     */
    quit: (): Promise<void> => ipcRenderer.invoke('kiosk:quit'),
  },
});
