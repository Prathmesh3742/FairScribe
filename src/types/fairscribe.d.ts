/**
 * fairscribe.d.ts
 *
 * TypeScript declarations for the window.fairscribe API exposed by
 * electron/preload.ts via contextBridge.
 *
 * These types must stay in sync with the preload script.
 */

export interface QuestionItem {
  questionId: string;
  questionText: string;
  marks: number;
}

export interface QuestionPaperData {
  examId: string;
  examTitle: string;
  duration: number;
  questions: QuestionItem[];
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
