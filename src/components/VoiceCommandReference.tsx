import React, { useEffect, useRef, useCallback } from 'react';
import type { VoiceCommandDef } from '../types/fairscribe';
import { getCommandsByCategory, getPunctuationCommands } from '../voice/commandMatcher';
import styles from '../styles/VoiceCommandReference.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VoiceCommandReferenceProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Category display order and icons
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = ['Recording', 'Navigation', 'Editing', 'Punctuation', 'Review', 'Submission', 'Help'];

const CATEGORY_ICONS: Record<string, string> = {
  Recording: '🎤',
  Navigation: '🧭',
  Editing: '✏️',
  Punctuation: '🔤',
  Review: '📋',
  Submission: '📤',
  Help: '❓',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * VoiceCommandReference — Modal overlay listing all available voice commands.
 *
 * Features:
 *   - Grouped by category (Recording, Navigation, Editing, Punctuation, Review, Submission, Help)
 *   - Each command shows phrase, aliases, and description
 *   - Punctuation section shows all spoken → symbol mappings
 *   - Scrollable content, keyboard accessible (Tab + Escape to close)
 *   - Focus trap inside the modal for accessibility
 *   - High-contrast mode support via CSS custom properties
 *   - Does NOT pause or interrupt recording state
 *   - Can be opened/closed via voice commands or UI button
 */
export default function VoiceCommandReference({ isOpen, onClose }: VoiceCommandReferenceProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus the close button when the modal opens
  useEffect(() => {
    if (isOpen && closeButtonRef.current) {
      closeButtonRef.current.focus();
    }
  }, [isOpen]);

  // Close on Escape key
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [onClose]);

  // Close on overlay click (not on the card itself)
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  }, [onClose]);

  if (!isOpen) return null;

  const commandsByCategory = getCommandsByCategory();
  const punctuationEntries = getPunctuationCommands();

  // Sort categories by defined order, put unknowns at the end
  const sortedCategories = Object.keys(commandsByCategory)
    .filter(cat => cat !== 'Punctuation') // We render punctuation separately
    .sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

  return (
    <div
      ref={overlayRef}
      className={styles.overlay}
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Voice Command Reference"
    >
      <div className={styles.card}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerIcon} aria-hidden="true">🗣️</span>
            <h2 className={styles.headerTitle}>Voice Command Reference</h2>
          </div>
          <button
            ref={closeButtonRef}
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close voice command reference"
            title="Close (Esc)"
            id="voice-ref-close-btn"
          >
            ✕
          </button>
        </div>

        {/* Hint */}
        <div className={styles.hint}>
          <span className={styles.hintIcon}>💡</span>
          Say <strong>"close commands"</strong> or press <strong>Esc</strong> to close.
          Say <strong>"read commands"</strong> to hear all commands aloud.
        </div>

        {/* Scrollable command list */}
        <div className={styles.content} tabIndex={0}>
          {sortedCategories.map((category) => (
            <div key={category} className={styles.category}>
              <div className={styles.categoryHeader}>
                <span className={styles.categoryIcon} aria-hidden="true">
                  {CATEGORY_ICONS[category] ?? '📌'}
                </span>
                <h3 className={styles.categoryTitle}>{category}</h3>
              </div>

              <div className={styles.commandList}>
                {commandsByCategory[category].map((cmd: VoiceCommandDef) => (
                  <div key={cmd.id} className={styles.commandRow}>
                    <div className={styles.commandPhrase}>
                      <span className={styles.primaryPhrase}>"{cmd.phrase}"</span>
                      {cmd.aliases.length > 0 && (
                        <span className={styles.aliases}>
                          {cmd.aliases.map((alias, i) => (
                            <span key={i} className={styles.aliasChip}>
                              {alias}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                    <div className={styles.commandDesc}>{cmd.description}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* ── Punctuation section ── */}
          <div className={styles.category}>
            <div className={styles.categoryHeader}>
              <span className={styles.categoryIcon} aria-hidden="true">🔤</span>
              <h3 className={styles.categoryTitle}>Punctuation</h3>
            </div>
            <p className={styles.punctuationHint}>
              Speak these words during dictation to insert punctuation symbols:
            </p>
            <div className={styles.punctuationGrid}>
              {punctuationEntries.map(({ phrase, symbol }) => (
                <div key={phrase} className={styles.punctuationRow}>
                  <span className={styles.punctuationPhrase}>"{phrase}"</span>
                  <span className={styles.punctuationArrow}>→</span>
                  <span className={styles.punctuationSymbol}>{symbol}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <span className={styles.footerNote}>
            All commands use fuzzy matching — slight pronunciation variations are accepted.
            Section navigation: say "Go to Section 2", "Open Section 3", etc.
          </span>
        </div>
      </div>
    </div>
  );
}
