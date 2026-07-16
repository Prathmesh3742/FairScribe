import React from 'react';
import styles from '../styles/components.module.css';

interface Props {
  /** 0-based index of the currently displayed question */
  currentIndex: number;
  total: number;
  onNavigate: (index: number) => void;
}

/**
 * QuestionNav — navigation controls for the question paper
 *
 * Provides:
 *   - Previous / Next buttons
 *   - Numbered jump buttons (one per question)
 *
 * Every navigation event calls onNavigate(index), which triggers
 * both a React state update and a "question_navigated" AuditLog entry
 * (the parent QuestionPaper.tsx handles the audit call).
 */
export default function QuestionNav({ currentIndex, total, onNavigate }: Props) {
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < total - 1;

  return (
    <nav className={styles.questionNav} aria-label="Question navigation">
      {/* Previous button */}
      <button
        id="nav-prev"
        className={`${styles.navBtn} ${styles.navBtnPrev}`}
        onClick={() => onNavigate(currentIndex - 1)}
        disabled={!canGoPrev}
        aria-label="Previous question"
      >
        ← Previous
      </button>

      {/* Numbered jump buttons */}
      <div className={styles.jumpButtons} role="group" aria-label="Jump to question">
        {Array.from({ length: total }, (_, i) => (
          <button
            key={i}
            id={`nav-jump-${i + 1}`}
            className={`${styles.jumpBtn} ${i === currentIndex ? styles.jumpBtnActive : ''}`}
            onClick={() => onNavigate(i)}
            aria-label={`Question ${i + 1}`}
            aria-current={i === currentIndex ? 'true' : 'false'}
          >
            {i + 1}
          </button>
        ))}
      </div>

      {/* Next button */}
      <button
        id="nav-next"
        className={`${styles.navBtn} ${styles.navBtnNext}`}
        onClick={() => onNavigate(currentIndex + 1)}
        disabled={!canGoNext}
        aria-label="Next question"
      >
        Next →
      </button>
    </nav>
  );
}
