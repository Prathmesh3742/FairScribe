/**
 * examSession.ts — Exam Session State
 *
 * Provides a React context holding all data that persists across screens
 * within a single exam session: student identity, exam metadata, question
 * list, and the active question index.
 *
 * This context is populated at login time and lives in the renderer process
 * memory for the duration of the session. Because kiosk activation is done
 * in-place (setKiosk on the existing window), this state survives the
 * transition to kiosk mode without a re-fetch.
 */

import React, { createContext, useContext, useState, type ReactNode } from 'react';
import type { QuestionItem } from '../types/fairscribe';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExamSession {
  studentId: string;
  studentName: string;
  examId: string;
  examTitle: string;
  /** Exam duration in seconds (e.g. 7200 = 2 hours) */
  duration: number;
  questions: QuestionItem[];
  /** 0-based index of the currently displayed question */
  currentQuestionIndex: number;
}

interface ExamSessionContextValue {
  session: ExamSession | null;
  setSession: (session: ExamSession | null) => void;
  setCurrentQuestionIndex: (index: number) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ExamSessionContext = createContext<ExamSessionContextValue | null>(null);

export function ExamSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<ExamSession | null>(null);

  const setSession = (s: ExamSession | null) => setSessionState(s);

  const setCurrentQuestionIndex = (index: number) => {
    setSessionState((prev) => {
      if (!prev) return prev;
      return { ...prev, currentQuestionIndex: index };
    });
  };

  return (
    <ExamSessionContext.Provider
      value={{ session, setSession, setCurrentQuestionIndex }}
    >
      {children}
    </ExamSessionContext.Provider>
  );
}

/**
 * Hook to consume the exam session context.
 * Throws if called outside <ExamSessionProvider>.
 */
export function useExamSession(): ExamSessionContextValue {
  const ctx = useContext(ExamSessionContext);
  if (!ctx) {
    throw new Error('useExamSession must be used within <ExamSessionProvider>');
  }
  return ctx;
}
