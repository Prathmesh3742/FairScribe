import React, { useEffect, useRef, useState } from 'react';
import styles from '../styles/components.module.css';

interface Props {
  /** Total exam duration in seconds */
  durationSeconds: number;
}

/**
 * Timer — Phase 2 countdown display
 *
 * Counts down from `durationSeconds` and displays the remaining time
 * in HH:MM:SS format. Displayed prominently in the top-right corner of
 * the question paper screen.
 *
 * PHASE 5 NOTE: This component is intentionally view-only. It does NOT
 * trigger auto-submit when it reaches zero. Auto-submit behavior (writing
 * a "time_expired" audit event, locking the editor, and initiating the
 * submission flow) is deferred to Phase 5. When the timer hits 00:00:00
 * it simply holds there visually.
 */
export default function Timer({ durationSeconds }: Props) {
  const [remaining, setRemaining] = useState(durationSeconds);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Reset if durationSeconds changes (e.g. session reload)
    setRemaining(durationSeconds);
  }, [durationSeconds]);

  useEffect(() => {
    if (remaining <= 0) return;

    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);  // Run once on mount; durationSeconds handled by the effect above

  // Format seconds → HH:MM:SS
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  const formatted = [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');

  const isLow = remaining <= 300;    // Under 5 minutes: warning
  const isCritical = remaining <= 60; // Under 1 minute: critical

  return (
    <div
      className={`${styles.timer} ${isLow ? styles.timerLow : ''} ${isCritical ? styles.timerCritical : ''}`}
      aria-live="off"    // Suppress continuous screen reader announcements
      aria-label={`Time remaining: ${formatted}`}
      role="timer"
    >
      <span className={styles.timerLabel}>Time Remaining</span>
      <span className={styles.timerDisplay}>{formatted}</span>
    </div>
  );
}
