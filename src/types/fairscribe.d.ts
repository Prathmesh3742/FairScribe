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
    };
  }
}
