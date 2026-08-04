import React from 'react';
import type { VoiceMode, VoiceCommandId } from '../types/fairscribe';
import { getActiveCommands } from '../voice/commandMatcher';
import styles from '../styles/VoiceCommandStatus.module.css';

/**
 * VoiceCommandStatus — Voice command status bar component
 *
 * Displays:
 *   - Current voice mode (Command Mode / Recording / Paused / Processing)
 *   - Microphone status indicator with distinct visual states per mode
 *   - Last recognized command (brief flash feedback via ARIA assertive)
 *   - Context-sensitive voice command suggestions
 *   - Error messages with dismiss button
 *
 * Accessibility improvements:
 *   - ARIA live="polite" for mode changes (non-disruptive announcement)
 *   - ARIA live="assertive" for command recognition (immediate announcement)
 *   - ARIA role="status" on the container for screen readers
 *   - Descriptive aria-label on all interactive/informational elements
 *   - Distinct color coding: blue = command mode, red = recording,
 *     amber = paused, purple = processing, green = submitted
 *   - High contrast mode support via CSS custom properties
 */

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VoiceCommandStatusProps {
  /** Current voice engine mode. */
  mode: VoiceMode;
  /** Whether the voice engine is active and processing. */
  isActive: boolean;
  /** Last matched command for feedback display. */
  lastCommand: { id: VoiceCommandId; label: string; timestamp: number } | null;
  /** Error message to display. */
  error: string | null;
  /** Callback to dismiss the error. */
  onDismissError: () => void;
}

// ---------------------------------------------------------------------------
// Mode display config
// ---------------------------------------------------------------------------

const MODE_CONFIG: Record<VoiceMode, {
  label: string;
  description: string;
  className: string;
  icon: string;
}> = {
  command_idle: {
    label: 'Initializing',
    description: 'Voice system is starting up',
    className: styles.modeIdle,
    icon: '⏳',
  },
  command_listening: {
    label: 'Command Mode',
    description: 'Listening for voice commands. Say a command to act.',
    className: styles.modeCommandListening,
    icon: '🎯',
  },
  dictation_recording: {
    label: '● Recording',
    description: 'Dictation is active. Everything you say is transcribed.',
    className: styles.modeDictationRecording,
    icon: '🔴',
  },
  dictation_paused: {
    label: '⏸ Paused',
    description: 'Dictation is paused. Say "resume recording" to continue.',
    className: styles.modeDictationPaused,
    icon: '⏸',
  },
  processing: {
    label: '⚙ Verifying',
    description: 'Verifying transcript with Whisper AI. Please wait.',
    className: styles.modeProcessing,
    icon: '⚙',
  },
  confirming_submit: {
    label: '⚠ Confirm Submit?',
    description: 'Say "confirm submit" to finalize or "cancel" to go back.',
    className: styles.modeConfirming,
    icon: '⚠',
  },
  submitted: {
    label: 'Submitted ✓',
    description: 'Examination submitted successfully.',
    className: styles.modeSubmitted,
    icon: '✅',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VoiceCommandStatus({
  mode,
  isActive,
  lastCommand,
  error,
  onDismissError,
}: VoiceCommandStatusProps) {
  const config = MODE_CONFIG[mode];
  const activeCommands = getActiveCommands(mode);

  // Only show first 4 suggestions to save space
  // Filter out punctuation suggestions from the status bar (too many)
  const suggestions = activeCommands
    .filter(cmd => cmd.id !== 'insert_punctuation')
    .slice(0, 4);

  // Determine mic status
  const micStatus =
    mode === 'command_idle' || mode === 'submitted'
      ? 'inactive'
      : error
      ? 'error'
      : mode === 'dictation_recording'
      ? 'recording'
      : mode === 'dictation_paused'
      ? 'paused'
      : 'active';

  return (
    <div
      className={styles.voiceStatusBar}
      role="status"
      aria-label={`Voice system: ${config.description}`}
    >
      {/* ── Microphone icon with mode-dependent state ── */}
      <div
        className={`${styles.micIcon} ${
          micStatus === 'recording'
            ? styles.micRecording
            : micStatus === 'paused'
            ? styles.micPaused
            : micStatus === 'active'
            ? styles.micActive
            : micStatus === 'error'
            ? styles.micError
            : styles.micInactive
        }`}
        aria-label={
          micStatus === 'recording' ? 'Microphone recording'
          : micStatus === 'paused'  ? 'Microphone paused'
          : micStatus === 'active'  ? 'Microphone active'
          : micStatus === 'error'   ? 'Microphone error'
          : 'Microphone inactive'
        }
        title={
          micStatus === 'recording' ? 'Microphone active — recording dictation'
          : micStatus === 'paused'  ? 'Microphone paused — say "resume recording"'
          : micStatus === 'active'  ? 'Microphone active — listening for commands'
          : micStatus === 'error'   ? 'Microphone error — check permissions'
          : 'Microphone inactive'
        }
      >
        🎤
      </div>

      {/* ── Mode indicator pill ── */}
      <div
        className={`${styles.modePill} ${config.className}`}
        aria-live="polite"
        aria-atomic="true"
        aria-label={`Voice mode: ${config.label}`}
        title={config.description}
      >
        <span className={styles.modeDot} aria-hidden="true" />
        <span>{config.label}</span>
      </div>

      {/* ── Processing spinner (only in processing mode) ── */}
      {mode === 'processing' && (
        <div className={styles.processingSpinner} aria-hidden="true" title="Processing…" />
      )}

      {/* ── Last command feedback — assertive so screen readers announce immediately ── */}
      {lastCommand && (
        <div
          className={styles.lastCommand}
          key={lastCommand.timestamp}
          aria-live="assertive"
          aria-atomic="true"
          aria-label={`Command recognized: ${lastCommand.label}`}
        >
          <span className={styles.lastCommandIcon}>✓</span>
          {lastCommand.label}
        </div>
      )}

      {/* Spacer */}
      <div className={styles.spacer} />

      {/* ── Command suggestions ── */}
      {isActive && suggestions.length > 0 && mode !== 'submitted' && (
        <div
          className={styles.suggestions}
          aria-label="Available voice commands"
          aria-hidden="true"  /* Decorative — screen readers use the mode description */
        >
          <span className={styles.suggestionsLabel}>Say:</span>
          {suggestions.map((cmd) => (
            <span
              key={cmd.id}
              className={styles.suggestionChip}
              title={cmd.description}
            >
              "{cmd.phrase}"
            </span>
          ))}
        </div>
      )}

      {/* ── Error banner ── */}
      {error && (
        <div
          className={styles.errorBanner}
          role="alert"
          aria-live="assertive"
        >
          <span>⚠ {error}</span>
          <button
            onClick={onDismissError}
            aria-label="Dismiss voice error"
            id="voice-error-dismiss-btn"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
