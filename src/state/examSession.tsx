/**
 * examSession.tsx — Exam Session State (Phase 3 upgrade)
 *
 * Provides a React context holding all data that persists across screens
 * within a single exam session: student identity, exam metadata, section
 * list, current navigation position, and the live question status map.
 *
 * Phase 3 additions:
 *   - sections[]       — full section array from the question paper JSON
 *   - instructions     — exam instructions displayed on the Instructions screen
 *   - currentSectionId — which section the candidate is currently in
 *   - currentQuestionId— which specific question is displayed
 *   - statusMap        — in-memory Map<questionId, QuestionStatus>
 *                        kept in sync with the Answer DB table after every action
 *   - statusSummary    — derived counts per status, consumed by palette + submit modal
 *
 * statusMap is the source of truth for the UI. Every status change is
 * persisted to the DB immediately (via exam:updateAnswerStatus IPC) before
 * the in-memory map is updated, so a crash cannot lose palette state.
 *
 * This context is populated at login time and lives in the renderer process
 * memory for the duration of the session. Because kiosk activation is done
 * in-place (setKiosk on the existing window), this state survives the
 * transition to kiosk mode without a re-fetch.
 */

import React, { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type {
  SectionItem,
  ExamInstructions,
  QuestionStatus,
  StatusSummary,
} from '../types/fairscribe';

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
  /** All sections with their nested questions */
  sections: SectionItem[];
  /** Exam instructions shown on the Instructions screen */
  instructions: ExamInstructions;
  /** sectionId of the currently displayed section */
  currentSectionId: string;
  /** questionId of the currently displayed question */
  currentQuestionId: string;
  /**
   * In-memory map of questionId → status.
   * This is the canonical palette source of truth — the DB is kept in sync
   * via exam:updateAnswerStatus IPC on every change.
   */
  statusMap: Map<string, QuestionStatus>;
}

interface ExamSessionContextValue {
  session: ExamSession | null;
  setSession: (session: ExamSession | null) => void;
  /** Navigate to a question within the current (or given) section. */
  setCurrentQuestion: (questionId: string, sectionId?: string) => void;
  /**
   * Update the status for a specific question in the in-memory map.
   * The caller is responsible for also persisting to the DB via IPC.
   */
  updateQuestionStatus: (questionId: string, status: QuestionStatus) => void;
  /** Derived status counts, recomputed whenever statusMap changes. */
  statusSummary: StatusSummary;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ExamSessionContext = createContext<ExamSessionContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute per-status counts from a status map. O(n) over question count. */
function computeStatusSummary(statusMap: Map<string, QuestionStatus>): StatusSummary {
  const summary: StatusSummary = {
    not_visited: 0,
    not_answered: 0,
    answered: 0,
    marked_for_review: 0,
    answered_marked_for_review: 0,
    total: statusMap.size,
  };
  for (const status of statusMap.values()) {
    summary[status]++;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ExamSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<ExamSession | null>(null);
  const [statusSummary, setStatusSummary] = useState<StatusSummary>({
    not_visited: 0,
    not_answered: 0,
    answered: 0,
    marked_for_review: 0,
    answered_marked_for_review: 0,
    total: 0,
  });

  const setSession = useCallback((s: ExamSession | null) => {
    setSessionState(s);
    if (s) {
      setStatusSummary(computeStatusSummary(s.statusMap));
    } else {
      setStatusSummary({
        not_visited: 0,
        not_answered: 0,
        answered: 0,
        marked_for_review: 0,
        answered_marked_for_review: 0,
        total: 0,
      });
    }
  }, []);

  /**
   * Navigate to a question. Optionally also changes the active section.
   * Does NOT alter question status — status transitions are explicit via
   * updateQuestionStatus().
   */
  const setCurrentQuestion = useCallback(
    (questionId: string, sectionId?: string) => {
      setSessionState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          currentQuestionId: questionId,
          currentSectionId: sectionId ?? prev.currentSectionId,
        };
      });
    },
    []
  );

  /**
   * Update the in-memory status map for one question.
   * Creates a new Map instance so React detects the reference change and
   * re-renders the palette.
   *
   * IMPORTANT: Callers must persist to the DB via exam:updateAnswerStatus IPC
   * BEFORE calling this — the DB write is the crash-safe source of truth.
   */
  const updateQuestionStatus = useCallback(
    (questionId: string, status: QuestionStatus) => {
      setSessionState((prev) => {
        if (!prev) return prev;
        const newMap = new Map(prev.statusMap);
        newMap.set(questionId, status);
        // Recompute summary synchronously inside the updater
        setStatusSummary(computeStatusSummary(newMap));
        return { ...prev, statusMap: newMap };
      });
    },
    []
  );

  return (
    <ExamSessionContext.Provider
      value={{ session, setSession, setCurrentQuestion, updateQuestionStatus, statusSummary }}
    >
      {children}
    </ExamSessionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

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
