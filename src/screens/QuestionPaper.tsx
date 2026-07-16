import React, { useState } from 'react';
import { useExamSession } from '../state/examSession';
import QuestionNav from '../components/QuestionNav';
import Timer from '../components/Timer';
import AccessibilityControls from '../components/AccessibilityControls';
import styles from '../styles/QuestionPaper.module.css';
import submitStyles from '../styles/Submit.module.css';

/**
 * QuestionPaper — Phase 2: Exam Question Viewer
 *
 * Displays one question at a time with:
 *   - "Question N of M" header
 *   - Full question text with adjustable font scale
 *   - Marks indicator
 *   - Placeholder panel for Phase 3 answer editor
 *   - QuestionNav: Previous / Next / jump buttons
 *   - Timer: countdown from Exam.duration
 *   - AccessibilityControls: zoom + high-contrast
 *
 * Every navigation event writes a "question_navigated" AuditLog entry
 * via the audit:logEvent IPC channel.
 */
export default function QuestionPaper() {
  const { session, setCurrentQuestionIndex } = useExamSession();

  // Accessibility state (session-only, not persisted to disk)
  const [fontScale, setFontScale] = useState(1.0);
  const [highContrast, setHighContrast] = useState(false);

  // Submission state
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!session) {
    return <div className={styles.error}>Session not found. Please restart the application.</div>;
  }

  const { questions, currentQuestionIndex, examTitle, studentName, duration } = session;
  const currentQuestion = questions[currentQuestionIndex];
  const totalQuestions = questions.length;

  // ── Submit handler ──
  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await window.fairscribe.exam.submit(session.examId, {
        studentId: session.studentId,
        questionsAttempted: totalQuestions,
      });
      setSubmitted(true);
    } catch (err) {
      console.error('Submit failed:', err);
    } finally {
      setSubmitting(false);
      setShowConfirm(false);
    }
  };

  // ── Auto-quit countdown after submission ──
  const [countdown, setCountdown] = useState(10);

  React.useEffect(() => {
    if (!submitted) return;
    if (countdown <= 0) {
      window.fairscribe.kiosk.quit();
      return;
    }
    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [submitted, countdown]);

  // ── Post-submission screen ──
  if (submitted) {
    return (
      <div className={submitStyles.submittedRoot}>
        <div className={submitStyles.submittedCard}>
          <div className={submitStyles.submittedIcon}>✅</div>
          <h1 className={submitStyles.submittedTitle}>Examination Submitted</h1>
          <p className={submitStyles.submittedSubtitle}>
            Your answers have been recorded and secured.
          </p>
          <div className={submitStyles.submittedDetails}>
            <div className={submitStyles.detailRow}>
              <span className={submitStyles.detailLabel}>Candidate</span>
              <span className={submitStyles.detailValue}>{studentName}</span>
            </div>
            <div className={submitStyles.detailRow}>
              <span className={submitStyles.detailLabel}>Exam</span>
              <span className={submitStyles.detailValue}>{examTitle}</span>
            </div>
            <div className={submitStyles.detailRow}>
              <span className={submitStyles.detailLabel}>Status</span>
              <span className={submitStyles.detailValue} style={{color: 'var(--color-success)'}}>Submitted ✓</span>
            </div>
          </div>
          <p className={submitStyles.submittedNote}>
            Please remain seated. The invigilator will collect this device.
          </p>
          <p className={submitStyles.countdownText}>
            Application closing in <strong>{countdown}</strong> second{countdown !== 1 ? 's' : ''}…
          </p>
        </div>
      </div>
    );
  }

  const handleNavigate = async (index: number) => {
    if (index < 0 || index >= totalQuestions || index === currentQuestionIndex) return;

    // Update UI immediately
    setCurrentQuestionIndex(index);

    // Write audit entry — every navigation is logged
    await window.fairscribe.audit.logEvent('question_navigated', {
      fromIndex: currentQuestionIndex,
      toIndex: index,
      questionId: questions[index].questionId,
    });
  };

  return (
    <div className={styles.root}>
      {/* ─── Top bar ─── */}
      <header className={styles.topBar}>
        <div className={styles.examInfo}>
          <span className={styles.examTitle}>{examTitle}</span>
          <span className={styles.candidateName}>{studentName}</span>
        </div>
        <Timer durationSeconds={duration} />
      </header>

      {/* ─── Accessibility controls bar ─── */}
      <div className={styles.a11yBar}>
        <AccessibilityControls
          fontScale={fontScale}
          onFontScaleChange={setFontScale}
          highContrast={highContrast}
          onHighContrastChange={setHighContrast}
        />
      </div>

      {/* ─── Main content area ─── */}
      <main className={styles.mainContent}>
        {/* Question panel */}
        <section className={styles.questionPanel} aria-label="Question">
          {/* Question header */}
          <div className={styles.questionHeader}>
            <h2 className={styles.questionCounter}>
              Question {currentQuestionIndex + 1} of {totalQuestions}
            </h2>
            <span className={styles.marksBadge}>
              {currentQuestion.marks} {currentQuestion.marks === 1 ? 'mark' : 'marks'}
            </span>
          </div>

          {/* Question text — font scale applied via CSS custom property */}
          <div
            className={styles.questionTextContainer}
            style={{ fontSize: `calc(1rem * var(--question-font-scale, 1))` }}
          >
            <p className={styles.questionText}>{currentQuestion.questionText}</p>
          </div>
        </section>

        {/* ─── Phase 3 Answer Editor Placeholder ─── */}
        {/*
         * TODO (Phase 3): Replace this placeholder with the Slate.js
         * constrained answer editor. It should:
         *   - Accept dictated text from the Vosk real-time STT stream
         *   - Support voice commands (new line, delete last word, undo, redo)
         *   - Track full edit history (each insertion/deletion timestamped)
         *   - Write edit events to AuditLog via audit:logEvent IPC
         *   - Autosave answer text every 5 seconds
         *
         * The editor state (current text + edit history) maps to the
         * Answer table defined as a TODO in electron/db/schema.sql.
         */}
        <section className={styles.answerPlaceholder} aria-label="Answer area (coming in Phase 3)">
          <div className={styles.placeholderInner}>
            <span className={styles.placeholderIcon}>🎤</span>
            <p className={styles.placeholderTitle}>Answer Editor</p>
            <p className={styles.placeholderDesc}>
              Dictation and answer editing will be available here in Phase 3.
            </p>
          </div>
        </section>
      </main>

      {/* ─── Navigation bar ─── */}
      <footer className={styles.navBar}>
        <div className={submitStyles.navBarInner}>
          <QuestionNav
            currentIndex={currentQuestionIndex}
            total={totalQuestions}
            onNavigate={handleNavigate}
          />
          <button
            className={submitStyles.submitBtn}
            onClick={() => setShowConfirm(true)}
            aria-label="Submit examination"
          >
            Submit Exam
          </button>
        </div>
      </footer>

      {/* ─── Submission confirmation modal ─── */}
      {showConfirm && (
        <div className={submitStyles.modalOverlay}>
          <div className={submitStyles.modalCard}>
            <div className={submitStyles.modalIcon}>⚠️</div>
            <h2 className={submitStyles.modalTitle}>Submit Examination?</h2>
            <p className={submitStyles.modalDesc}>
              Once submitted, you <strong>cannot</strong> return to edit your answers.
              Please review all questions before confirming.
            </p>
            <div className={submitStyles.modalActions}>
              <button
                className={submitStyles.modalCancelBtn}
                onClick={() => setShowConfirm(false)}
                disabled={submitting}
              >
                Go Back
              </button>
              <button
                className={submitStyles.modalConfirmBtn}
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? 'Submitting…' : 'Confirm Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
