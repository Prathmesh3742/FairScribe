/**
 * useActionHistory.ts — Application-Level Action History
 *
 * Provides a lightweight global undo/redo stack for reversible UI actions
 * that go beyond text editing — including question/section navigation,
 * mark/unmark for review, and answer clear operations.
 *
 * Design:
 *   - The DictationPanel maintains its own text undo/redo (per-question).
 *   - This hook tracks higher-level exam actions so that, e.g., marking a
 *     question for review can be undone even after navigating away.
 *   - When the voice "undo" command fires in QuestionPaper, text undo is
 *     attempted first (via DictationPanel ref). If nothing was undone
 *     (history exhausted), the app-level history is consulted next.
 *
 * Usage:
 *   const { pushAction, undo, redo, canUndo, canRedo } = useActionHistory();
 *
 *   // Record a reversible action:
 *   pushAction({
 *     type: 'mark',
 *     description: 'Mark Q3 for review',
 *     undo: async () => { await unmarkQuestion(q3); },
 *     redo: async () => { await markQuestion(q3); },
 *   });
 *
 *   // Later:
 *   await undo(); // Reverts the mark
 */

import { useRef, useCallback, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionType =
  | 'navigation'     // Question/section navigation
  | 'mark'           // Mark for review
  | 'unmark'         // Unmark review
  | 'clear'          // Clear answer
  | 'section_nav'    // Section navigation
  | 'recording';     // Recording start/stop

export interface HistoryEntry {
  /** Semantic type for debugging and display. */
  type: ActionType;
  /** Human-readable description (for TTS feedback). */
  description: string;
  /** Reverse the action. */
  undo: () => Promise<void>;
  /** Re-apply the action after an undo. */
  redo: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MAX_HISTORY = 30;

export interface UseActionHistoryResult {
  /** Push a new reversible action onto the history stack. */
  pushAction: (entry: HistoryEntry) => void;
  /** Undo the most recent action. Returns its description or null if nothing to undo. */
  undo: () => Promise<string | null>;
  /** Redo the most recently undone action. Returns its description or null if nothing to redo. */
  redo: () => Promise<string | null>;
  /** True when there is at least one action to undo. */
  canUndo: boolean;
  /** True when there is at least one action to redo. */
  canRedo: boolean;
  /** Number of items currently in the undo stack. */
  undoCount: number;
  /** Clear the entire history (e.g., on exam submit). */
  clearHistory: () => void;
}

export function useActionHistory(): UseActionHistoryResult {
  // We store history in a ref to avoid triggering re-renders on every action,
  // but expose canUndo/canRedo as state so the UI updates when those change.
  const historyRef = useRef<HistoryEntry[]>([]);
  const indexRef = useRef<number>(-1); // Points to the last applied action

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [undoCount, setUndoCount] = useState(0);

  const syncState = useCallback(() => {
    const idx = indexRef.current;
    const len = historyRef.current.length;
    setCanUndo(idx >= 0);
    setCanRedo(idx < len - 1);
    setUndoCount(idx + 1);
  }, []);

  const pushAction = useCallback((entry: HistoryEntry) => {
    // Discard redo stack beyond current index
    const idx = indexRef.current;
    historyRef.current = historyRef.current.slice(0, idx + 1);
    historyRef.current.push(entry);

    // Enforce max history length
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current = historyRef.current.slice(
        historyRef.current.length - MAX_HISTORY
      );
    }
    indexRef.current = historyRef.current.length - 1;
    syncState();
  }, [syncState]);

  const undo = useCallback(async (): Promise<string | null> => {
    const idx = indexRef.current;
    if (idx < 0) return null; // Nothing to undo

    const entry = historyRef.current[idx];
    try {
      await entry.undo();
      indexRef.current = idx - 1;
      syncState();
      return entry.description;
    } catch (err) {
      console.error('[useActionHistory] Undo failed:', err);
      return null;
    }
  }, [syncState]);

  const redo = useCallback(async (): Promise<string | null> => {
    const idx = indexRef.current;
    const len = historyRef.current.length;
    if (idx >= len - 1) return null; // Nothing to redo

    const entry = historyRef.current[idx + 1];
    try {
      await entry.redo();
      indexRef.current = idx + 1;
      syncState();
      return entry.description;
    } catch (err) {
      console.error('[useActionHistory] Redo failed:', err);
      return null;
    }
  }, [syncState]);

  const clearHistory = useCallback(() => {
    historyRef.current = [];
    indexRef.current = -1;
    syncState();
  }, [syncState]);

  return { pushAction, undo, redo, canUndo, canRedo, undoCount, clearHistory };
}
