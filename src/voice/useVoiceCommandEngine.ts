/**
 * useVoiceCommandEngine.ts — React Hook for Voice Command Integration
 *
 * Bridges the VoiceCommandEngine to React components. Manages the engine
 * lifecycle, state machine transitions, and maps voice commands to
 * exam UI actions.
 *
 * Usage:
 *   const voice = useVoiceCommandEngine({
 *     actions: { startRecording, stopRecording, ... },
 *     studentId, examId, questionId,
 *     enabled: true,
 *   });
 *
 *   // voice.mode — current VoiceMode
 *   // voice.lastCommand — last matched command for UI feedback
 *   // voice.error — current error message
 *   // voice.commandSessionText — latest command session transcript
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  VoiceMode,
  VoiceCommandId,
  VoiceCommandEvent,
  VoiceCommandActions,
} from '../types/fairscribe';
import { VoiceCommandEngine } from './VoiceCommandEngine';
import { extractQuestionNumber, extractSectionNumber, PUNCTUATION_PHRASE_TO_SYMBOL } from './commandMatcher';
import * as tts from './ttsService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseVoiceCommandEngineOptions {
  /** Action callbacks that voice commands trigger. */
  actions: VoiceCommandActions;
  /** Current student ID. */
  studentId: string;
  /** Current exam ID. */
  examId: string;
  /** Current question ID — updated on navigation. */
  questionId: string;
  /** Whether voice commands are enabled. */
  enabled: boolean;
  /** Whether to auto-read questions via TTS. */
  autoReadQuestions?: boolean;
  /** Current question text (for TTS). */
  currentQuestionText?: string;
  /** Current question number (for TTS). */
  currentQuestionNumber?: number;
}

export interface VoiceCommandState {
  /** Current voice engine mode. */
  mode: VoiceMode;
  /** Last matched command (for UI feedback flash). */
  lastCommand: { id: VoiceCommandId; label: string; timestamp: number } | null;
  /** Current error message, if any. */
  error: string | null;
  /** Latest transcript from the command session (for debug). */
  commandSessionText: string;
  /** Whether the engine is active. */
  isActive: boolean;
  /** Expose engine mode control to sync with external components */
  setEngineMode: (newMode: VoiceMode) => void;
}

// ---------------------------------------------------------------------------
// Command label lookup
// ---------------------------------------------------------------------------

const COMMAND_LABELS: Record<VoiceCommandId, string> = {
  start_recording: 'Start Recording',
  stop_recording: 'Stop Recording',
  pause_recording: 'Pause Recording',
  resume_recording: 'Resume Recording',
  next_question: 'Next Question',
  previous_question: 'Previous Question',
  next_section: 'Next Section',
  previous_section: 'Previous Section',
  goto_question: 'Go to Question',
  goto_section: 'Go to Section',
  read_question: 'Read Question',
  repeat_question: 'Repeat Question',
  read_answer: 'Read Answer',
  save_answer: 'Save Answer',
  clear_answer: 'Clear Answer',
  new_line: 'New Line',
  delete_last_word: 'Delete Last Word',
  undo: 'Undo',
  redo: 'Redo',
  mark_review: 'Mark for Review',
  unmark_review: 'Unmark Review',
  submit_exam: 'Submit Exam',
  confirm_submit: 'Confirm Submit',
  cancel: 'Cancel',
  view_commands: 'Voice Commands',
  close_commands: 'Close Commands',
  read_commands: 'Read Commands',
  insert_punctuation: 'Insert Punctuation',
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVoiceCommandEngine(
  options: UseVoiceCommandEngineOptions
): VoiceCommandState {
  const {
    actions,
    studentId,
    examId,
    questionId,
    enabled,
    autoReadQuestions,
    currentQuestionText,
    currentQuestionNumber,
  } = options;

  // ── State ──
  const [mode, setMode] = useState<VoiceMode>('command_idle');
  const [lastCommand, setLastCommand] = useState<VoiceCommandState['lastCommand']>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandSessionText, setCommandSessionText] = useState('');
  const [isActive, setIsActive] = useState(false);

  // ── Refs ──
  const engineRef = useRef<VoiceCommandEngine | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const questionTextRef = useRef(currentQuestionText);
  questionTextRef.current = currentQuestionText;
  const questionNumberRef = useRef(currentQuestionNumber);
  questionNumberRef.current = currentQuestionNumber;
  const autoReadRef = useRef(autoReadQuestions);
  autoReadRef.current = autoReadQuestions;
  const modeRef = useRef<VoiceMode>('command_idle');

  // ── Command handler ──
  const handleCommand = useCallback(async (event: VoiceCommandEvent) => {
    const a = actionsRef.current;
    const label = COMMAND_LABELS[event.commandId];

    // Show command feedback in UI
    setLastCommand({ id: event.commandId, label, timestamp: Date.now() });

    // Clear the feedback after 2 seconds
    setTimeout(() => {
      setLastCommand((prev) =>
        prev && prev.timestamp === Date.now() - 2000 ? null : prev
      );
    }, 2000);

    // Log the command to audit
    window.fairscribe.audit.logEvent('voice_command', {
      commandId: event.commandId,
      rawText: event.rawText,
      confidence: event.confidence,
    }).catch(() => {});

    // Execute the command action
    try {
      switch (event.commandId) {
        case 'start_recording':
          await a.startRecording();
          break;

        case 'stop_recording':
          await a.stopRecording();
          break;

        case 'pause_recording':
          await a.pauseRecording();
          break;

        case 'resume_recording':
          await a.resumeRecording();
          break;

        case 'next_question':
          tts.stop(); // Stop any TTS before navigation
          await a.nextQuestion();
          break;

        case 'previous_question':
          tts.stop();
          await a.previousQuestion();
          break;

        case 'read_question':
        case 'repeat_question':
          a.readQuestion();
          break;

        case 'next_section':
          tts.stop();
          await a.nextSection();
          tts.announce('Next section');
          break;

        case 'previous_section':
          tts.stop();
          await a.previousSection();
          tts.announce('Previous section');
          break;

        case 'goto_question': {
          tts.stop();
          const qNum = event.params?.questionNumber as number | undefined
            ?? extractQuestionNumber(event.rawText);
          if (qNum != null) {
            await a.gotoQuestion(qNum);
            tts.announce(`Question ${qNum}`);
          } else {
            tts.announce('Could not determine question number.');
          }
          break;
        }

        case 'goto_section': {
          tts.stop();
          const sNum = event.params?.sectionNumber as number | undefined
            ?? extractSectionNumber(event.rawText);
          if (sNum != null) {
            await a.gotoSection(sNum);
          } else {
            tts.announce('Could not determine section number.');
          }
          break;
        }

        case 'mark_review':
          await a.markForReview();
          tts.announce('Marked for review');
          break;

        case 'unmark_review':
          await a.unmarkReview();
          tts.announce('Review flag removed');
          break;

        case 'save_answer':
          await a.saveAnswer();
          tts.announce('Answer saved.');
          break;

        case 'clear_answer':
          await a.clearAnswer();
          tts.announce('Answer cleared.');
          break;

        case 'new_line':
          a.newLine();
          tts.announce('New line');
          break;

        case 'delete_last_word':
          a.deleteLastWord();
          tts.announce('Word deleted');
          break;

        case 'insert_punctuation': {
          // The spoken phrase tells us which symbol to insert.
          // Resolve via the PUNCTUATION_PHRASE_TO_SYMBOL map.
          const spoken = event.rawText.toLowerCase().trim();
          const symbol = PUNCTUATION_PHRASE_TO_SYMBOL[spoken]
            ?? Object.entries(PUNCTUATION_PHRASE_TO_SYMBOL).find(([phrase]) =>
                spoken.includes(phrase)
              )?.[1];
          if (symbol) {
            a.insertPunctuation(symbol);
          }
          break;
        }

        case 'undo':
          a.undo();
          tts.announce('Undo');
          break;

        case 'redo':
          a.redo();
          tts.announce('Redo');
          break;

        case 'read_answer':
          a.readAnswer();
          break;

        case 'submit_exam':
          a.submitExam();
          break;

        case 'confirm_submit':
          await a.confirmSubmit();
          break;

        case 'cancel':
          a.cancelAction();
          tts.announce('Cancelled.');
          break;

        case 'view_commands':
          a.viewCommands();
          tts.announce('Showing voice commands');
          break;

        case 'close_commands':
          a.closeCommands();
          tts.announce('Commands closed');
          break;

        case 'read_commands':
          a.readCommands();
          break;
      }
    } catch (err: any) {
      console.error('[VoiceHook] Command execution error:', err);
      setError(`Command failed: ${err.message}`);
    }
  }, []);

  // ── Engine lifecycle ──
  useEffect(() => {
    if (!enabled || !studentId || !examId) {
      return;
    }

    const engine = new VoiceCommandEngine({
      onCommandDetected: handleCommand,
      onModeChange: (newMode) => {
        setMode(newMode);
        modeRef.current = newMode;
      },
      onError: (errMsg) => {
        setError(errMsg);
      },
      onCommandSessionTranscript: (text, isFinal) => {
        if (isFinal) {
          setCommandSessionText(text);
        }
      },
    });

    engine.setExamContext(studentId, examId, questionId);
    engineRef.current = engine;

    // Auto-start command mode after a brief delay (let the UI settle)
    const startTimer = setTimeout(async () => {
      try {
        await engine.startCommandMode();
        setIsActive(true);
      } catch (err: any) {
        setError(err.message);
      }
    }, 1500);

    return () => {
      clearTimeout(startTimer);
      engine.destroy();
      engineRef.current = null;
      setIsActive(false);
    };
  }, [enabled, studentId, examId, handleCommand]);

  // ── Update question ID on navigation ──
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.updateQuestionId(questionId);
    }
  }, [questionId]);

  // ── Auto-read question on navigation (if enabled) ──
  useEffect(() => {
    if (!autoReadRef.current) return;
    if (!questionTextRef.current) return;
    if (modeRef.current !== 'command_listening') return;

    // Small delay to let the UI render the new question before reading
    const readTimer = setTimeout(() => {
      if (questionTextRef.current) {
        tts.readQuestion(questionTextRef.current, questionNumberRef.current);
      }
    }, 500);

    return () => clearTimeout(readTimer);
  }, [questionId]);

  // ── Expose engine control methods ──
  const setEngineMode = useCallback((newMode: VoiceMode) => {
    const engine = engineRef.current;
    if (!engine) return;

    if (newMode === 'dictation_recording') {
      engine.enterDictationMode();
    } else if (newMode === 'dictation_paused') {
      engine.enterDictationPaused();
    } else if (newMode === 'processing') {
      engine.enterProcessingMode();
    } else if (newMode === 'confirming_submit') {
      engine.enterConfirmSubmitMode();
    } else if (newMode === 'command_listening') {
      engine.returnToCommandMode();
    }
  }, []);

  // ── Clear last command feedback after timeout ──
  useEffect(() => {
    if (!lastCommand) return;
    const timer = setTimeout(() => setLastCommand(null), 2500);
    return () => clearTimeout(timer);
  }, [lastCommand]);

  // ── Clear error after timeout ──
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error]);

  return {
    mode,
    lastCommand,
    error,
    commandSessionText,
    isActive,
    setEngineMode,
  };
}

/**
 * Helper to programmatically set the voice mode from outside the hook.
 * Used by DictationPanel and QuestionPaper to signal mode transitions.
 */
export function getVoiceEngine(): VoiceCommandEngine | null {
  // The engine is accessible via the ref in the hook.
  // This is a design limitation — the engine ref is local to the hook.
  // Instead, mode transitions are communicated via the actions interface.
  return null;
}
