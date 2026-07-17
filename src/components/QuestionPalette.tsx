import React from 'react';
import type { SectionItem, QuestionStatus } from '../types/fairscribe';
import styles from '../styles/QuestionPalette.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface QuestionPaletteProps {
  sections: SectionItem[];
  currentSectionId: string;
  currentQuestionId: string;
  statusMap: Map<string, QuestionStatus>;
  onSectionChange: (sectionId: string) => void;
  onQuestionSelect: (questionId: string, sectionId: string) => void;
}

// ---------------------------------------------------------------------------
// Status → CSS class mapping
// ---------------------------------------------------------------------------

function statusClass(status: QuestionStatus | undefined): string {
  switch (status) {
    case 'not_answered':              return styles.statusNotAnswered;
    case 'answered':                  return styles.statusAnswered;
    case 'marked_for_review':         return styles.statusMarkedForReview;
    case 'answered_marked_for_review':return styles.statusAnsweredMarked;
    case 'not_visited':
    default:                          return styles.statusNotVisited;
  }
}

// ---------------------------------------------------------------------------
// Legend configuration
// ---------------------------------------------------------------------------

const LEGEND_ITEMS: Array<{
  status: QuestionStatus;
  label: string;
  color: string;
  hasDot?: boolean;
}> = [
  { status: 'not_visited',                label: 'Not Visited',       color: '#c8d0da' },
  { status: 'not_answered',               label: 'Not Answered',      color: '#c01c28' },
  { status: 'answered',                   label: 'Answered',          color: '#2d7c3f' },
  { status: 'marked_for_review',          label: 'Marked for Review', color: '#7b3fa0' },
  { status: 'answered_marked_for_review', label: 'Answered & Marked', color: '#7b3fa0', hasDot: true },
];

// ---------------------------------------------------------------------------
// Helper: per-section answered count (for the tab badge)
// ---------------------------------------------------------------------------

function sectionAnsweredCount(
  section: SectionItem,
  statusMap: Map<string, QuestionStatus>
): { answered: number; total: number } {
  let answered = 0;
  for (const q of section.questions) {
    const s = statusMap.get(q.questionId);
    if (s === 'answered' || s === 'answered_marked_for_review') answered++;
  }
  return { answered, total: section.questions.length };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * QuestionPalette — Right panel of the exam screen.
 *
 * Renders:
 *  1. Section list — vertical card tabs; clicking changes the active section
 *     and navigates to its first question (via onSectionChange).
 *  2. Question grid — numbered buttons color-coded by status.
 *  3. Legend — 5-color key.
 *  4. Live summary counts — per-status totals.
 *
 * Navigation contract:
 *  - onSectionChange / onQuestionSelect are called; the parent (QuestionPaper)
 *    handles the not_visited → not_answered transition. The palette never
 *    mutates status itself.
 */
export default function QuestionPalette({
  sections,
  currentSectionId,
  currentQuestionId,
  statusMap,
  onSectionChange,
  onQuestionSelect,
}: QuestionPaletteProps) {

  const activeSection = sections.find((s) => s.sectionId === currentSectionId) ?? sections[0];

  // Compute summary counts from the full statusMap (all sections)
  const summary = React.useMemo(() => {
    const counts: Record<QuestionStatus, number> = {
      not_visited: 0,
      not_answered: 0,
      answered: 0,
      marked_for_review: 0,
      answered_marked_for_review: 0,
    };
    let total = 0;
    for (const status of statusMap.values()) {
      counts[status]++;
      total++;
    }
    return { ...counts, total };
  }, [statusMap]);

  // Global question index (1-based, across all sections) for button labels
  const questionIndexMap = React.useMemo(() => {
    const map = new Map<string, number>();
    let idx = 1;
    for (const section of sections) {
      for (const q of section.questions) {
        map.set(q.questionId, idx++);
      }
    }
    return map;
  }, [sections]);

  return (
    <div className={styles.palette} aria-label="Question palette">

      {/* ── Palette header ── */}
      <div className={styles.paletteHeader}>
        <div className={styles.paletteHeaderTitle}>Question Palette</div>
      </div>

      {/* ── Section list ── */}
      <div className={styles.sectionTabs} aria-label="Exam sections">
        <div className={styles.sectionTabList} role="tablist">
          {sections.map((section, i) => {
            const isActive = section.sectionId === currentSectionId;
            const { answered, total } = sectionAnsweredCount(section, statusMap);

            return (
              <button
                key={section.sectionId}
                role="tab"
                aria-selected={isActive}
                className={`${styles.sectionTab} ${isActive ? styles.sectionTabActive : ''}`}
                onClick={() => onSectionChange(section.sectionId)}
                title={section.sectionName}
              >
                <span className={styles.sectionTabNum}>{i + 1}</span>
                <span className={styles.sectionTabText}>{section.sectionName}</span>
                <span className={styles.sectionTabCount}>{answered}/{total}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Question grid (for the active section) ── */}
      <div className={styles.gridArea} role="tabpanel">
        {activeSection && (
          <>
            <div className={styles.gridSectionHeader}>
              <div className={styles.gridSectionDot} />
              <span className={styles.gridSectionTitle}>{activeSection.sectionName}</span>
            </div>

            <div className={styles.questionGrid} role="list">
              {activeSection.questions.map((question) => {
                const status = statusMap.get(question.questionId) ?? 'not_visited';
                const isActive = question.questionId === currentQuestionId;
                const globalIndex = questionIndexMap.get(question.questionId) ?? 0;
                const isAnsweredMarked = status === 'answered_marked_for_review';

                return (
                  <button
                    key={question.questionId}
                    role="listitem"
                    className={`${styles.qBtn} ${statusClass(status)} ${
                      isActive ? styles.qBtnActive : ''
                    }`}
                    onClick={() => onQuestionSelect(question.questionId, activeSection.sectionId)}
                    aria-label={`Question ${globalIndex}, status: ${status.replace(/_/g, ' ')}`}
                    aria-current={isActive ? 'true' : undefined}
                    title={`Q${globalIndex} — ${status.replace(/_/g, ' ')}`}
                  >
                    {globalIndex}
                    {isAnsweredMarked && (
                      <span className={styles.greenDot} aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ── Legend ── */}
      <div className={styles.legend} aria-label="Status legend">
        <div className={styles.legendTitle}>Legend</div>
        <div className={styles.legendItems}>
          {LEGEND_ITEMS.map((item) => (
            <div key={item.status} className={styles.legendItem}>
              <div
                className={styles.legendSwatch}
                style={{ background: item.color }}
                aria-hidden="true"
              >
                {item.hasDot && <span className={styles.legendSwatchDot} />}
              </div>
              <span className={styles.legendText}>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Live summary counts ── */}
      <div className={styles.summary} aria-label="Question status summary">
        <div className={styles.summaryTitle}>Summary (All Sections)</div>
        <div className={styles.summaryGrid}>
          <div className={styles.summaryItem}>
            <div className={styles.summaryDot} style={{ background: '#2d7c3f' }} />
            <span className={styles.summaryLabel}>Answered</span>
            <span className={styles.summaryCount}>{summary.answered}</span>
          </div>
          <div className={styles.summaryItem}>
            <div className={styles.summaryDot} style={{ background: '#c01c28' }} />
            <span className={styles.summaryLabel}>Not Ans.</span>
            <span className={styles.summaryCount}>{summary.not_answered}</span>
          </div>
          <div className={styles.summaryItem}>
            <div className={styles.summaryDot} style={{ background: '#7b3fa0' }} />
            <span className={styles.summaryLabel}>Review</span>
            <span className={styles.summaryCount}>
              {summary.marked_for_review + summary.answered_marked_for_review}
            </span>
          </div>
          <div className={styles.summaryItem}>
            <div
              className={styles.summaryDot}
              style={{ background: '#c8d0da', border: '1px solid #aaa' }}
            />
            <span className={styles.summaryLabel}>Not Visited</span>
            <span className={styles.summaryCount}>{summary.not_visited}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
