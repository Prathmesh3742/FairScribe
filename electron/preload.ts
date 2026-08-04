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
     * Returns the parsed question paper data (sections + instructions).
     */
    loadQuestionPaper: (examId: string): Promise<{
      examId: string;
      examTitle: string;
      duration: number;
      sections: Array<{
        sectionId: string;
        sectionName: string;
        sectionOrder: number;
        questions: Array<{
          questionId: string;
          questionText: string;
          marks: number;
        }>;
      }>;
      instructions: {
        general: string[];
        examSpecific: string[];
        markingScheme?: string;
      };
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

    /**
     * Bulk-initialize Answer rows for all questions with status='not_visited'.
     * Called once when the candidate acknowledges the Instructions screen.
     * Uses INSERT OR IGNORE — safe to call again after a crash.
     */
    initAnswers: (
      questionIds: string[],
      studentId: string
    ): Promise<void> => ipcRenderer.invoke('exam:initAnswers', questionIds, studentId),

    /**
     * Persist a single question's status to the Answer table.
     * Called immediately on every Save & Next / Mark for Review action.
     * Never batched — crash-safe.
     */
    updateAnswerStatus: (
      questionId: string,
      studentId: string,
      status: string,
      answerText: string
    ): Promise<void> =>
      ipcRenderer.invoke('exam:updateAnswerStatus', questionId, studentId, status, answerText),

    /**
     * Return all Answer rows for a student from the DB.
     * Used to rehydrate the in-memory status map (e.g. after a crash-recovery).
     */
    getAnswerStatuses: (
      studentId: string
    ): Promise<Array<{
      questionId: string;
      studentId: string;
      answerText: string;
      status: string;
      visitedAt: string | null;
      lastModifiedAt: string | null;
    }>> => ipcRenderer.invoke('exam:getAnswerStatuses', studentId),
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

  // -------------------------------------------------------------------------
  // stt namespace — Phase 3: Speech-to-Text service bridge
  // -------------------------------------------------------------------------
  stt: {
    /**
     * Check if the Python STT service is running.
     * Returns health status including engine availability.
     */
    healthCheck: (): Promise<any> =>
      ipcRenderer.invoke('stt:healthCheck'),

    /**
     * Create an STT session for the current question.
     * Also opens a WebSocket stream in the main process.
     */
    startSession: (config: {
      studentId: string;
      examId: string;
      questionId: string;
      language?: string;
    }): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke('stt:startSession', config),

    /**
     * Send a raw PCM audio chunk to the STT service.
     * The chunk is forwarded from the renderer to main to the Python WebSocket.
     */
    sendAudio: (sessionId: string, chunk: ArrayBuffer): Promise<void> =>
      ipcRenderer.invoke('stt:sendAudio', sessionId, chunk),

    /**
     * Stop recording and trigger Whisper verification.
     * Returns the verified transcript.
     */
    stopRecording: (sessionId: string): Promise<any> =>
      ipcRenderer.invoke('stt:stopRecording', sessionId),

    /**
     * Delete an STT session and free resources.
     */
    deleteSession: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke('stt:deleteSession', sessionId),

    /**
     * Register a callback for real-time transcript events pushed
     * from the main process (via WebSocket → main → renderer).
     *
     * Returns an unsubscribe function.
     */
    onTranscript: (callback: (data: any) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('stt:transcript', handler);
      return () => {
        ipcRenderer.removeListener('stt:transcript', handler);
      };
    },
  },
});
