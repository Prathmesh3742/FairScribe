import React, { useState } from 'react';
import { useExamSession } from '../state/examSession';
import styles from '../styles/Instructions.module.css';

interface Props {
  onProceed: () => void;
}

/**
 * Instructions — Phase 3 Gate
 *
 * Shown after student login + kiosk activation, before the exam screen.
 * Renders the exam instructions from the question paper JSON and requires
 * the candidate to explicitly acknowledge before proceeding.
 *
 * On proceeding:
 *   1. Writes 'instructions_acknowledged' to the audit log.
 *   2. Calls exam:initAnswers — bulk-inserts Answer rows (not_visited) for
 *      every question in the exam into the DB.
 *   3. Calls onProceed() to transition to the exam screen.
 *
 * This screen is rendered inside the already-active kiosk window. Kiosk
 * mode was activated at login time (Login.tsx → kiosk:activate). Do not
 * move that activation here.
 */
export default function Instructions({ onProceed }: Props) {
  const { session } = useExamSession();
  const [acknowledged, setAcknowledged] = useState(false);
  const [isProceeding, setIsProceeding] = useState(false);

  if (!session) {
    return <div>Session not found. Please restart the application.</div>;
  }

  const { examTitle, duration, sections, instructions, studentId } = session;

  // Derived exam metadata
  const totalQuestions = sections.reduce((sum, s) => sum + s.questions.length, 0);
  const durationHours = Math.floor(duration / 3600);
  const durationMins = Math.floor((duration % 3600) / 60);
  const durationLabel =
    durationHours > 0
      ? durationMins > 0
        ? `${durationHours}h ${durationMins}m`
        : `${durationHours} hour${durationHours > 1 ? 's' : ''}`
      : `${durationMins} minutes`;

  const handleProceed = async () => {
    if (!acknowledged || isProceeding) return;
    setIsProceeding(true);

    try {
      // 1. Write audit entry
      await window.fairscribe.audit.logEvent('instructions_acknowledged', {
        studentId,
        examId: session.examId,
      });

      // 2. Bulk-initialize Answer rows for every question in the DB.
      //    Uses INSERT OR IGNORE — safe if called again after a crash.
      const allQuestionIds = sections.flatMap((s) =>
        s.questions.map((q) => q.questionId)
      );
      await window.fairscribe.exam.initAnswers(allQuestionIds, studentId);

      // 3. Transition to exam screen
      onProceed();
    } catch (err) {
      console.error('Failed to initialize exam:', err);
      // Don't block the candidate — let them proceed anyway
      // (status tracking may be incomplete but exam should not be locked)
      onProceed();
    } finally {
      setIsProceeding(false);
    }
  };

  return (
    <div className={styles.root}>
      {/* ─── Top bar ─── */}
      <header className={styles.topBar}>
        <div className={styles.examBrand}>
          <div className={styles.logoMark}>FS</div>
          <span className={styles.examTitle}>{examTitle}</span>
        </div>
        <div className={styles.topBarMeta}>
          <span className={styles.metaPill}>
            <span className={styles.metaPillIcon}>📋</span>
            {sections.length} Section{sections.length !== 1 ? 's' : ''}
          </span>
          <span className={styles.metaPill}>
            <span className={styles.metaPillIcon}>❓</span>
            {totalQuestions} Question{totalQuestions !== 1 ? 's' : ''}
          </span>
          <span className={styles.metaPill}>
            <span className={styles.metaPillIcon}>⏱️</span>
            {durationLabel}
          </span>
        </div>
      </header>

      {/* ─── Scrollable instruction content ─── */}
      <div className={styles.scrollArea}>
        <div className={styles.content}>
          {/* Page heading */}
          <div className={styles.pageHeading}>
            <h1 className={styles.pageTitle}>Examination Instructions</h1>
            <p className={styles.pageSubtitle}>
              Please read all instructions carefully before proceeding.
            </p>
          </div>

          {/* Exam metadata summary */}
          <div className={styles.examMeta}>
            <span className={styles.metaBadge}>
              🏷️ Exam: <strong>{examTitle}</strong>
            </span>
            <span className={styles.metaBadge}>
              ⏱️ Duration: <strong>{durationLabel}</strong>
            </span>
            <span className={styles.metaBadge}>
              📂 Sections: <strong>{sections.length}</strong>
            </span>
            <span className={styles.metaBadge}>
              ❓ Questions: <strong>{totalQuestions}</strong>
            </span>
          </div>

          {/* General instructions */}
          {instructions.general.length > 0 && (
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardIcon}>📌</span>
                <h2 className={styles.cardTitle}>General Instructions</h2>
              </div>
              <div className={styles.cardBody}>
                <ol className={styles.instructionList}>
                  {instructions.general.map((text, i) => (
                    <li key={i} className={styles.instructionItem}>
                      <span className={styles.bullet}>{i + 1}</span>
                      <p className={styles.instructionText}>{text}</p>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}

          {/* Exam-specific instructions */}
          {instructions.examSpecific.length > 0 && (
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardIcon}>📄</span>
                <h2 className={styles.cardTitle}>Paper-Specific Instructions</h2>
              </div>
              <div className={styles.cardBody}>
                <ol className={styles.instructionList}>
                  {instructions.examSpecific.map((text, i) => (
                    <li key={i} className={styles.instructionItem}>
                      <span className={styles.bullet}>{i + 1}</span>
                      <p className={styles.instructionText}>{text}</p>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}

          {/* Marking scheme (optional) */}
          {instructions.markingScheme && (
            <div className={styles.markingCard}>
              <span className={styles.markingIcon}>✅</span>
              <p className={styles.markingText}>
                <strong>Marking Scheme: </strong>
                {instructions.markingScheme}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ─── Footer: acknowledgment checkbox + proceed button ─── */}
      <footer className={styles.footer}>
        <label className={styles.checkboxLabel} htmlFor="instructions-ack">
          <input
            id="instructions-ack"
            type="checkbox"
            className={styles.checkbox}
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            disabled={isProceeding}
          />
          <span className={styles.checkboxText}>
            I have read and understood the above instructions.
          </span>
        </label>

        <button
          id="proceed-to-exam"
          className={styles.proceedBtn}
          onClick={handleProceed}
          disabled={!acknowledged || isProceeding}
          aria-disabled={!acknowledged || isProceeding}
        >
          {isProceeding ? 'Starting Exam…' : 'Proceed to Exam →'}
        </button>
      </footer>
    </div>
  );
}
