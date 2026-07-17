import React, { useState, useCallback } from 'react';
import { useExamSession } from '../state/examSession';
import type { QuestionStatus } from '../types/fairscribe';
import QuestionPalette from '../components/QuestionPalette';
import Timer from '../components/Timer';
import AccessibilityControls from '../components/AccessibilityControls';
import styles from '../styles/QuestionPaper.module.css';
import submitStyles from '../styles/Submit.module.css';

/**
 * QuestionPaper — Phase 3 (partial): Sectioned Exam with Status Palette
 *
 * Layout:
 *   top-bar → a11y-bar → [left: question panel | right: palette] → nav-bar
 *
 * Navigation + status transition logic:
 *
 *   OPENING a question:
 *     - If status is 'not_visited' → transition to 'not_answered', log it.
 *     - If already visited → navigate only, do not change status.
 *
 *   "Save & Next" button:
 *     - Stub answer has content (dev toggle) → 'answered'
 *     - No content → 'not_answered'
 *     - Persists to DB, updates statusMap, logs 'question_status_changed'.
 *     - Navigates to next question in section order; wraps to next section.
 *
 *   "Mark for Review & Next" button:
 *     - Stub answer has content → 'answered_marked_for_review'
 *     - No content → 'marked_for_review'
 *     - Same navigation behavior as Save & Next.
 *
 *   Palette click on already-visited question:
 *     - Navigates only — does NOT alter status.
 *     - Only 'not_visited' gets auto-transitioned on open.
 *
 * All status changes are persisted to the Answer DB table immediately
 * (via exam:updateAnswerStatus IPC) before the in-memory map is updated,
 * so a crash cannot lose palette state.
 */

// ---------------------------------------------------------------------------
// Helper: find next question across section boundaries
// ---------------------------------------------------------------------------

interface QPointer { sectionId: string; questionId: string }

/**
 * Returns the QPointer for the question following the given one, considering
 * all sections in order. Returns null if it's the last question in the exam.
 */
function nextQuestion(
  sections: { sectionId: string; questions: { questionId: string }[] }[],
  currentSectionId: string,
  currentQuestionId: string
): QPointer | null {
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    if (section.sectionId !== currentSectionId) continue;

    const qi = section.questions.findIndex((q) => q.questionId === currentQuestionId);
    if (qi === -1) break;

    // Try next in same section
    if (qi + 1 < section.questions.length) {
      return { sectionId: section.sectionId, questionId: section.questions[qi + 1].questionId };
    }
    // Wrap to next section's first question
    if (si + 1 < sections.length) {
      const nextSection = sections[si + 1];
      return { sectionId: nextSection.sectionId, questionId: nextSection.questions[0].questionId };
    }
    // Already at last question of last section
    return null;
  }
  return null;
}

/**
 * Returns the QPointer for the question preceding the given one, considering
 * all sections in reverse order. Returns null if it's the first question.
 */
function prevQuestion(
  sections: { sectionId: string; questions: { questionId: string }[] }[],
  currentSectionId: string,
  currentQuestionId: string
): QPointer | null {
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    if (section.sectionId !== currentSectionId) continue;

    const qi = section.questions.findIndex((q) => q.questionId === currentQuestionId);
    if (qi === -1) break;

    // Try previous in same section
    if (qi - 1 >= 0) {
      return { sectionId: section.sectionId, questionId: section.questions[qi - 1].questionId };
    }
    // Wrap to previous section's last question
    if (si - 1 >= 0) {
      const prevSection = sections[si - 1];
      const lastQ = prevSection.questions[prevSection.questions.length - 1];
      return { sectionId: prevSection.sectionId, questionId: lastQ.questionId };
    }
    // Already at first question
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function QuestionPaper() {
  const { session, setCurrentQuestion, updateQuestionStatus, statusSummary } =
    useExamSession();

  // Accessibility state
  const [fontScale, setFontScale] = useState(1.0);
  const [highContrast, setHighContrast] = useState(false);

  // Submission state
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [countdown, setCountdown] = useState(10);

  // ---------------------------------------------------------------------------
  // [DEV] Temporary stub answer toggle — Phase 3 dictation placeholder
  //
  // TODO (Phase 3 dictation): REMOVE this state and the toggle UI when the
  // real Vosk/ASR dictation engine is integrated. Replace with actual
  // answerText derived from the Slate.js editor content.
  //
  // This is ONLY here so the palette status transitions (answered / not_answered
  // / marked_for_review / answered_marked_for_review) are demonstrable
  // end-to-end while the dictation engine is not yet built.
  // ---------------------------------------------------------------------------
  const [devHasAnswer, setDevHasAnswer] = useState<Record<string, boolean>>({});

  // ---------------------------------------------------------------------------
  // Error guard
  // ---------------------------------------------------------------------------
  if (!session) {
    return (
      <div className={styles.error}>Session not found. Please restart the application.</div>
    );
  }

  const {
    sections,
    currentSectionId,
    currentQuestionId,
    statusMap,
    examTitle,
    studentName,
    studentId,
    duration,
    examId,
  } = session;

  // ---------------------------------------------------------------------------
  // Derived values for the current question
  // ---------------------------------------------------------------------------
  const currentSection = sections.find((s) => s.sectionId === currentSectionId) ?? sections[0];
  const currentQuestion = currentSection?.questions.find(
    (q) => q.questionId === currentQuestionId
  ) ?? currentSection?.questions[0];

  // Global question index for "Question N of M" display
  let globalIndex = 0;
  let totalQuestions = 0;
  for (const section of sections) {
    for (const q of section.questions) {
      totalQuestions++;
      if (q.questionId === currentQuestion?.questionId) {
        globalIndex = totalQuestions;
      }
    }
  }

  // Whether the [DEV] stub considers this question "answered"
  const stubHasContent = devHasAnswer[currentQuestion?.questionId ?? ''] ?? false;

  // ---------------------------------------------------------------------------
  // Core: open a question (handles not_visited → not_answered transition)
  // ---------------------------------------------------------------------------

  const openQuestion = useCallback(
    async (questionId: string, sectionId: string) => {
      const currentStatus = statusMap.get(questionId) ?? 'not_visited';

      // Navigate first (immediate UI feedback)
      setCurrentQuestion(questionId, sectionId);

      if (currentStatus === 'not_visited') {
        // Persist to DB first (crash-safe), then update in-memory map
        await window.fairscribe.exam.updateAnswerStatus(
          questionId, studentId, 'not_answered', ''
        );
        await window.fairscribe.audit.logEvent('question_status_changed', {
          questionId,
          fromStatus: 'not_visited',
          toStatus: 'not_answered',
        });
        updateQuestionStatus(questionId, 'not_answered');
      }
      // If already visited → do nothing to status (navigate only)
    },
    [statusMap, studentId, setCurrentQuestion, updateQuestionStatus]
  );

  // ---------------------------------------------------------------------------
  // Palette: section tab change
  // ---------------------------------------------------------------------------

  const handleSectionChange = useCallback(
    async (sectionId: string) => {
      if (sectionId === currentSectionId) return;

      const newSection = sections.find((s) => s.sectionId === sectionId);
      if (!newSection || newSection.questions.length === 0) return;

      await window.fairscribe.audit.logEvent('section_changed', {
        fromSectionId: currentSectionId,
        toSectionId: sectionId,
      });

      // Navigate to the first question of the selected section
      await openQuestion(newSection.questions[0].questionId, sectionId);
    },
    [currentSectionId, sections, openQuestion]
  );

  // ---------------------------------------------------------------------------
  // Palette: direct question click
  // ---------------------------------------------------------------------------

  const handlePaletteQuestionSelect = useCallback(
    async (questionId: string, sectionId: string) => {
      if (questionId === currentQuestionId) return;
      await openQuestion(questionId, sectionId);
    },
    [currentQuestionId, openQuestion]
  );

  // ---------------------------------------------------------------------------
  // Shared: persist status + navigate forward
  // ---------------------------------------------------------------------------

  const persistStatusAndAdvance = useCallback(
    async (newStatus: QuestionStatus) => {
      if (!currentQuestion) return;
      const fromStatus = statusMap.get(currentQuestion.questionId) ?? 'not_visited';

      // 1. Persist to DB immediately (crash-safe)
      const answerText = stubHasContent ? '[DEV_STUB_ANSWERED]' : '';
      await window.fairscribe.exam.updateAnswerStatus(
        currentQuestion.questionId, studentId, newStatus, answerText
      );

      // 2. Audit log
      await window.fairscribe.audit.logEvent('question_status_changed', {
        questionId: currentQuestion.questionId,
        fromStatus,
        toStatus: newStatus,
      });

      // 3. Update in-memory map
      updateQuestionStatus(currentQuestion.questionId, newStatus);

      // 4. Navigate to next question
      const next = nextQuestion(sections, currentSectionId, currentQuestion.questionId);
      if (next) {
        await openQuestion(next.questionId, next.sectionId);
      }
      // If null (last question), stay on current question
    },
    [currentQuestion, statusMap, stubHasContent, studentId, sections, currentSectionId,
      updateQuestionStatus, openQuestion]
  );

  // ---------------------------------------------------------------------------
  // Button handlers
  // ---------------------------------------------------------------------------

  const handleSaveAndNext = useCallback(async () => {
    const newStatus: QuestionStatus = stubHasContent ? 'answered' : 'not_answered';
    await persistStatusAndAdvance(newStatus);
  }, [stubHasContent, persistStatusAndAdvance]);

  const handleMarkAndNext = useCallback(async () => {
    const newStatus: QuestionStatus = stubHasContent
      ? 'answered_marked_for_review'
      : 'marked_for_review';
    await persistStatusAndAdvance(newStatus);
  }, [stubHasContent, persistStatusAndAdvance]);

  /**
   * Previous — navigate to the preceding question without changing its status.
   * If the previous question is 'not_visited', openQuestion will auto-transition
   * it to 'not_answered' (same logic as palette click / Save & Next landing).
   */
  const handlePrevious = useCallback(async () => {
    if (!currentQuestion) return;
    const prev = prevQuestion(sections, currentSectionId, currentQuestion.questionId);
    if (prev) {
      await openQuestion(prev.questionId, prev.sectionId);
    }
  }, [currentQuestion, sections, currentSectionId, openQuestion]);

  // ---------------------------------------------------------------------------
  // Submit handler
  // ---------------------------------------------------------------------------

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await window.fairscribe.exam.submit(examId, {
        studentId,
        totalQuestions,
        answered: statusSummary.answered + statusSummary.answered_marked_for_review,
        markedForReview: statusSummary.marked_for_review + statusSummary.answered_marked_for_review,
      });
      setSubmitted(true);
    } catch (err) {
      console.error('Submit failed:', err);
    } finally {
      setSubmitting(false);
      setShowConfirm(false);
    }
  };

  // Auto-quit countdown after submission
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

  // ---------------------------------------------------------------------------
  // Post-submission screen
  // ---------------------------------------------------------------------------

  if (submitted) {
    return (
      <div className={submitStyles.submittedRoot}>
        <div className={submitStyles.submittedCard}>
          <div className={submitStyles.submittedHeader}>
            <div className={submitStyles.submittedIcon}>✅</div>
            <h1 className={submitStyles.submittedTitle}>Examination Submitted</h1>
            <p className={submitStyles.submittedSubtitle}>
              Your answers have been recorded and secured.
            </p>
          </div>
          <div className={submitStyles.submittedBody}>
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
                <span
                  className={submitStyles.detailValue}
                  style={{ color: 'var(--color-success)' }}
                >
                  Submitted ✓
                </span>
              </div>
            </div>
            <p className={submitStyles.submittedNote}>
              Please remain seated. The invigilator will collect this device.
            </p>
            <p className={submitStyles.countdownText}>
              Application closing in{' '}
              <strong>{countdown}</strong>{' '}
              second{countdown !== 1 ? 's' : ''}…
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main exam layout
  // ---------------------------------------------------------------------------

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

      {/* ─── Main content: left question panel + right palette ─── */}
      <main className={styles.mainContent}>

        {/* ── Left panel ── */}
        <div className={styles.leftPanel}>
          <section
            className={styles.questionPanel}
            aria-label="Question"
            style={{ fontSize: `calc(1rem * ${fontScale})` }}
          >
            {/* Question header */}
            <div className={styles.questionHeader}>
              <div className={styles.questionMeta}>
                <h2 className={styles.questionCounter}>
                  Question {globalIndex} of {totalQuestions}
                </h2>
                <span className={styles.sectionBreadcrumb}>
                  {currentSection?.sectionName}
                </span>
              </div>
              <span className={styles.marksBadge}>
                {currentQuestion?.marks}{' '}
                {currentQuestion?.marks === 1 ? 'mark' : 'marks'}
              </span>
            </div>

            {/* Question text */}
            <div className={styles.questionTextContainer}>
              <p className={styles.questionText}>
                {currentQuestion?.questionText}
              </p>
            </div>

            {/* ─── [DEV] Stub Answer Toggle ───────────────────────────────
             * TODO (Phase 3 dictation): REMOVE this entire block when the
             * Vosk/ASR real-time dictation engine is integrated (Phase 3).
             *
             * Purpose: allows testers to simulate "has answer" / "no answer"
             * so that the 5-state palette (answered / not_answered /
             * answered_marked_for_review / marked_for_review) can be
             * exercised end-to-end before real dictation is available.
             *
             * This does NOT write real answer text — it only sets a boolean
             * that controls which status value is written to the DB on
             * Save & Next / Mark for Review & Next.
             ─────────────────────────────────────────────────────────────── */}
            <div className={styles.devAnswerToggle}>
              <span className={styles.devBadge}>DEV</span>
              <label
                className={styles.devToggleLabel}
                htmlFor={`dev-answer-${currentQuestion?.questionId}`}
              >
                <input
                  id={`dev-answer-${currentQuestion?.questionId}`}
                  type="checkbox"
                  className={styles.devToggleCheckbox}
                  checked={stubHasContent}
                  onChange={(e) =>
                    setDevHasAnswer((prev) => ({
                      ...prev,
                      [currentQuestion?.questionId ?? '']: e.target.checked,
                    }))
                  }
                />
                <span className={styles.devToggleText}>
                  [DEV] Simulate answer content for this question
                </span>
              </label>
            </div>

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
             * Answer table's answerText and lastModifiedAt columns.
             */}
            <div className={styles.answerPlaceholder} aria-label="Answer area (Phase 3)">
              <div className={styles.placeholderInner}>
                <span className={styles.placeholderIcon}>🎤</span>
                <p className={styles.placeholderTitle}>Answer Editor</p>
                <p className={styles.placeholderDesc}>
                  Dictation and answer editing will be available here in Phase 3.
                </p>
              </div>
            </div>
          </section>

          {/* ── Action buttons: Previous | Save & Next | Mark for Review & Next | Submit ── */}
          <div className={styles.navBar}>
            <div className={submitStyles.navBarInner}>
              {/* Previous — navigates back without changing status */}
              <button
                className={submitStyles.prevBtn}
                onClick={handlePrevious}
                disabled={prevQuestion(sections, currentSectionId, currentQuestion?.questionId ?? '') === null}
                aria-label="Go to previous question"
              >
                ← Previous
              </button>

              {/* Divider separates back-nav from action buttons */}
              <div className={submitStyles.navDivider} aria-hidden="true" />

              <button
                className={submitStyles.saveNextBtn}
                onClick={handleSaveAndNext}
                aria-label="Save answer and go to next question"
              >
                Save &amp; Next
              </button>
              <button
                className={submitStyles.markReviewBtn}
                onClick={handleMarkAndNext}
                aria-label="Mark for review and go to next question"
              >
                Mark for Review &amp; Next
              </button>

              {/* Spacer pushes Submit to the far right */}
              <div className={submitStyles.navSpacer} />

              <button
                className={submitStyles.submitBtn}
                onClick={() => setShowConfirm(true)}
                aria-label="Submit examination"
              >
                Submit Exam
              </button>
            </div>
          </div>
        </div>

        {/* ── Right palette panel ── */}
        <QuestionPalette
          sections={sections}
          currentSectionId={currentSectionId}
          currentQuestionId={currentQuestion?.questionId ?? ''}
          statusMap={statusMap}
          onSectionChange={handleSectionChange}
          onQuestionSelect={handlePaletteQuestionSelect}
        />
      </main>

      {/* ─── Submission confirmation modal ─── */}
      {showConfirm && (
        <div className={submitStyles.modalOverlay}>
          <div className={submitStyles.modalCard}>
            <div className={submitStyles.modalHeader}>
              <div className={submitStyles.modalIcon}>⚠️</div>
              <h2 className={submitStyles.modalTitle}>Submit Examination?</h2>
            </div>
            <div className={submitStyles.modalBody}>
              {/* Live status summary pulled from statusSummary derived from Answer table state */}
              <div className={styles.submitSummary}>
                <div className={styles.submitSummaryRow}>
                  <div className={styles.submitSummaryDot} style={{ background: '#2d7c3f' }} />
                  <span>Answered</span>
                  <span className={styles.submitSummaryCount}>
                    {statusSummary.answered + statusSummary.answered_marked_for_review}
                  </span>
                  <span>of {totalQuestions} questions</span>
                </div>
                <div className={styles.submitSummaryRow}>
                  <div className={styles.submitSummaryDot} style={{ background: '#c01c28' }} />
                  <span>Not Answered</span>
                  <span className={styles.submitSummaryCount}>
                    {statusSummary.not_answered}
                  </span>
                </div>
                <div className={styles.submitSummaryRow}>
                  <div className={styles.submitSummaryDot} style={{ background: '#7b3fa0' }} />
                  <span>Marked for Review</span>
                  <span className={styles.submitSummaryCount}>
                    {statusSummary.marked_for_review + statusSummary.answered_marked_for_review}
                  </span>
                </div>
                <div className={styles.submitSummaryRow}>
                  <div
                    className={styles.submitSummaryDot}
                    style={{ background: '#d0d0d0', border: '1px solid #aaa' }}
                  />
                  <span>Not Visited</span>
                  <span className={styles.submitSummaryCount}>
                    {statusSummary.not_visited}
                  </span>
                </div>
              </div>

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
        </div>
      )}
    </div>
  );
}
