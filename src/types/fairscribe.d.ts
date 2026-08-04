/**
 * fairscribe.d.ts
 *
 * TypeScript declarations for the window.fairscribe API exposed by
 * electron/preload.ts via contextBridge.
 *
 * These types must stay in sync with the preload script.
 */

// ---------------------------------------------------------------------------
// Shared domain types
// ---------------------------------------------------------------------------

export interface QuestionItem {
  questionId: string;
  questionText: string;
  marks: number;
}

export interface SectionItem {
  sectionId: string;
  sectionName: string;
  sectionOrder: number;
  questions: QuestionItem[];
}

export interface ExamInstructions {
  general: string[];
  examSpecific: string[];
  markingScheme?: string;
}

/**
 * The 5 question status values used throughout the palette, status map,
 * and Answer table. These are the only valid values.
 *
 * Lifecycle:
 *   not_visited → not_answered (on first open)
 *   not_answered → answered | marked_for_review | answered_marked_for_review (via buttons)
 *   answered → not_answered | marked_for_review | answered_marked_for_review (revisit + act)
 *   marked_for_review → answered_marked_for_review | not_answered | answered (revisit + act)
 *   answered_marked_for_review → answered | marked_for_review | not_answered (revisit + act)
 */
export type QuestionStatus =
  | 'not_visited'
  | 'not_answered'
  | 'answered'
  | 'marked_for_review'
  | 'answered_marked_for_review';

/** One Answer row as returned from DB via exam:getAnswerStatuses IPC. */
export interface AnswerStatusRow {
  questionId: string;
  studentId: string;
  answerText: string;
  status: QuestionStatus;
  visitedAt: string | null;
  lastModifiedAt: string | null;
}

/** Derived summary counts used by the palette legend and submit modal. */
export interface StatusSummary {
  not_visited: number;
  not_answered: number;
  answered: number;
  marked_for_review: number;
  answered_marked_for_review: number;
  total: number;
}

export interface QuestionPaperData {
  examId: string;
  examTitle: string;
  duration: number;
  sections: SectionItem[];
  instructions: ExamInstructions;
  questionPaperHash: string;
}

export interface StudentSession {
  studentId: string;
  name: string;
  examId: string;
  disabilityCategory: string | null;
}

export interface ExamMeta {
  examId: string;
  examTitle: string;
  duration: number;
  languageConfig: string;
}

export interface LoginResult {
  student: StudentSession;
  exam: ExamMeta;
}

// ---------------------------------------------------------------------------
// Phase 3: STT / Dictation types
// ---------------------------------------------------------------------------

/**
 * Dictation UI state machine.
 *
 * idle → recording → paused → recording → ...
 *                  → processing → idle
 *                  → error → idle (retry)
 */
export type DictationStatus = 'idle' | 'recording' | 'paused' | 'processing' | 'error';

/** Response from GET /api/health on the Python STT service. */
export interface STTHealthResponse {
  status: string;
  version: string;
  uptime_seconds: number;
  engines: Record<string, {
    status: string;
    model_path: string | null;
    model_loaded: boolean;
    error: string | null;
  }>;
  active_sessions: number;
  config: Record<string, unknown>;
}

/** Config passed to stt:startSession. */
export interface STTSessionConfig {
  studentId: string;
  examId: string;
  questionId: string;
  language?: string;
}

/**
 * Real-time transcript event pushed from the Python STT service
 * via WebSocket → main process → renderer.
 */
export interface STTTranscriptEvent {
  sessionId: string;
  type: 'partial' | 'final' | 'status' | 'vad' | 'error';
  text: string;
  confidence: number;
  isSpeech: boolean;
  timestampMs: number;
}

/** Result from POST /api/sessions/{id}/stop (Whisper verification). */
export interface STTVerificationResult {
  sessionId: string;
  voskTranscript: string;
  whisperTranscript: string;
  finalTranscript: string;
  whisperAvailable: boolean;
  whisperConfidence: number;
  audioDurationSeconds: number;
  processingTimeSeconds: number;
  status: string;
}

// ---------------------------------------------------------------------------
// Phase 4: Voice Command types
// ---------------------------------------------------------------------------

/**
 * Voice command engine operating modes.
 *
 * State machine:
 *   COMMAND_IDLE → COMMAND_LISTENING → DICTATION_RECORDING ↔ DICTATION_PAUSED
 *                                   → CONFIRMING_SUBMIT → SUBMITTED
 *
 * COMMAND_IDLE         — Mic not yet started (initial state on exam load)
 * COMMAND_LISTENING    — Mic active, only predefined commands recognized
 * DICTATION_RECORDING  — Mic active, all speech → answer transcript
 * DICTATION_PAUSED     — Mic suspended, waiting for "resume recording"
 * PROCESSING           — Whisper verification in progress after stop
 * CONFIRMING_SUBMIT    — Awaiting "confirm submit" or "cancel"
 * SUBMITTED            — Exam finalized, voice engine stopped
 */
export type VoiceMode =
  | 'command_idle'
  | 'command_listening'
  | 'dictation_recording'
  | 'dictation_paused'
  | 'processing'
  | 'confirming_submit'
  | 'submitted';

/**
 * Identifiers for all supported voice commands.
 * Used as the canonical key in the command registry.
 */
export type VoiceCommandId =
  | 'start_recording'
  | 'stop_recording'
  | 'pause_recording'
  | 'resume_recording'
  | 'next_question'
  | 'previous_question'
  | 'next_section'
  | 'previous_section'
  | 'goto_question'
  | 'goto_section'
  | 'read_question'
  | 'repeat_question'
  | 'read_answer'
  | 'save_answer'
  | 'clear_answer'
  | 'new_line'
  | 'delete_last_word'
  | 'undo'
  | 'redo'
  | 'mark_review'
  | 'unmark_review'
  | 'submit_exam'
  | 'confirm_submit'
  | 'cancel'
  | 'view_commands'
  | 'close_commands'
  | 'read_commands'
  | 'insert_punctuation';

/**
 * A registered voice command definition.
 * Commands are matched against incoming transcript text using fuzzy matching.
 */
export interface VoiceCommandDef {
  /** Unique command identifier. */
  id: VoiceCommandId;
  /** Display label shown in the UI command suggestions. */
  label: string;
  /** Primary phrase that triggers this command. */
  phrase: string;
  /** Alternative phrases/aliases (all matched with fuzzy logic). */
  aliases: string[];
  /** Voice modes in which this command is active. */
  activeModes: VoiceMode[];
  /** Brief description for accessibility/screen readers. */
  description: string;
  /** Category for grouping in the command reference panel. */
  category?: 'Recording' | 'Navigation' | 'Editing' | 'Review' | 'Submission' | 'Help' | 'Punctuation';
}

/**
 * Event emitted when a voice command is successfully matched.
 */
export interface VoiceCommandEvent {
  /** The matched command. */
  commandId: VoiceCommandId;
  /** The raw transcript text that triggered the match. */
  rawText: string;
  /** Match confidence score (0–1). */
  confidence: number;
  /** Timestamp of the match. */
  timestampMs: number;
  /** Optional parameters extracted from the command (e.g., question number). */
  params?: Record<string, unknown>;
}

/**
 * Actions that the voice command engine can request from the exam UI.
 * Implemented by QuestionPaper and passed to the voice engine hook.
 */
export interface VoiceCommandActions {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  nextQuestion: () => Promise<void>;
  previousQuestion: () => Promise<void>;
  nextSection: () => Promise<void>;
  previousSection: () => Promise<void>;
  gotoQuestion: (questionNumber: number) => Promise<void>;
  gotoSection: (sectionNumber: number) => Promise<void>;
  readQuestion: () => void;
  readAnswer: () => void;
  saveAnswer: () => Promise<void>;
  clearAnswer: () => Promise<void>;
  newLine: () => void;
  deleteLastWord: () => void;
  insertPunctuation: (symbol: string) => void;
  undo: () => void;
  redo: () => void;
  markForReview: () => Promise<void>;
  unmarkReview: () => Promise<void>;
  submitExam: () => void;
  confirmSubmit: () => Promise<void>;
  cancelAction: () => void;
  viewCommands: () => void;
  closeCommands: () => void;
  readCommands: () => void;
}

// ---------------------------------------------------------------------------
// Window API declaration
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    fairscribe: {
      auth: {
        verifyPin(pin: string): Promise<boolean>;
        login(studentId: string, accessCode: string): Promise<LoginResult | null>;
      };
      exam: {
        loadQuestionPaper(examId: string): Promise<QuestionPaperData>;
        submit(examId: string, details: Record<string, unknown>): Promise<void>;
        /** Bulk-initialize Answer rows (not_visited) for all questions. */
        initAnswers(questionIds: string[], studentId: string): Promise<void>;
        /** Persist a single question status change immediately. */
        updateAnswerStatus(
          questionId: string,
          studentId: string,
          status: string,
          answerText: string
        ): Promise<void>;
        /** Fetch all Answer rows for a student (for rehydration). */
        getAnswerStatuses(studentId: string): Promise<AnswerStatusRow[]>;
      };
      audit: {
        logEvent(eventType: string, deviceState?: Record<string, unknown>): Promise<void>;
        verify(): Promise<{ valid: boolean; brokenAt?: number }>;
      };
      kiosk: {
        activate(): Promise<void>;
        quit(): Promise<void>;
      };
      /** Phase 3: Speech-to-text service bridge. */
      stt: {
        /** Check if the Python STT service is running and engines are loaded. */
        healthCheck(): Promise<STTHealthResponse>;
        /** Create an STT session for the current question. Returns sessionId. */
        startSession(config: STTSessionConfig): Promise<{ sessionId: string }>;
        /** Send a raw PCM audio chunk (16kHz mono 16-bit) to the STT service. */
        sendAudio(sessionId: string, chunk: ArrayBuffer): Promise<void>;
        /** Stop recording and run Whisper verification. */
        stopRecording(sessionId: string): Promise<STTVerificationResult>;
        /** Delete an STT session and free resources. */
        deleteSession(sessionId: string): Promise<void>;
        /**
         * Register a callback for real-time transcript events.
         * Returns an unsubscribe function.
         */
        onTranscript(callback: (data: STTTranscriptEvent) => void): () => void;
      };
    };
  }
}
