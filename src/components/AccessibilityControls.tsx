import React from 'react';
import styles from '../styles/components.module.css';

// Zoom scale boundaries (maps to --question-font-scale CSS custom property)
const ZOOM_MIN = 0.8;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

interface Props {
  /** Current font scale, e.g. 1.0 = 100% */
  fontScale: number;
  onFontScaleChange: (scale: number) => void;
  /** Whether high-contrast mode is currently active */
  highContrast: boolean;
  onHighContrastChange: (active: boolean) => void;
}

/**
 * AccessibilityControls — zoom and high-contrast toggles
 *
 * Zoom:
 *   A- / A+ buttons increment/decrement the CSS custom property
 *   `--question-font-scale` applied to the question text container.
 *   Range: 0.8x–2.0x in 0.1 steps.
 *
 * High Contrast:
 *   Toggle button adds/removes `data-theme="high-contrast"` on
 *   document.documentElement. The CSS block in global.css then
 *   applies explicit high-contrast colours (NOT a CSS filter invert —
 *   explicit colours are used for readability and accessibility compliance).
 *
 * Both settings live in renderer state only — they do not persist to disk
 * (session-only, per spec).
 */
export default function AccessibilityControls({
  fontScale,
  onFontScaleChange,
  highContrast,
  onHighContrastChange,
}: Props) {
  const handleZoomOut = () => {
    const next = Math.max(ZOOM_MIN, Math.round((fontScale - ZOOM_STEP) * 10) / 10);
    onFontScaleChange(next);
    document.documentElement.style.setProperty('--question-font-scale', String(next));
  };

  const handleZoomIn = () => {
    const next = Math.min(ZOOM_MAX, Math.round((fontScale + ZOOM_STEP) * 10) / 10);
    onFontScaleChange(next);
    document.documentElement.style.setProperty('--question-font-scale', String(next));
  };

  const handleHighContrastToggle = () => {
    const next = !highContrast;
    onHighContrastChange(next);
    if (next) {
      document.documentElement.setAttribute('data-theme', 'high-contrast');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  };

  const zoomPercent = Math.round(fontScale * 100);

  return (
    <div className={styles.a11yControls} aria-label="Accessibility controls">
      {/* Zoom controls */}
      <div className={styles.a11yGroup}>
        <span className={styles.a11yGroupLabel}>Text Size</span>
        <button
          id="a11y-zoom-out"
          className={styles.a11yBtn}
          onClick={handleZoomOut}
          disabled={fontScale <= ZOOM_MIN}
          aria-label={`Decrease text size (currently ${zoomPercent}%)`}
          title="Decrease text size"
        >
          A−
        </button>
        <span className={styles.a11yZoomValue} aria-live="polite" aria-label={`Text size ${zoomPercent} percent`}>
          {zoomPercent}%
        </span>
        <button
          id="a11y-zoom-in"
          className={styles.a11yBtn}
          onClick={handleZoomIn}
          disabled={fontScale >= ZOOM_MAX}
          aria-label={`Increase text size (currently ${zoomPercent}%)`}
          title="Increase text size"
        >
          A+
        </button>
      </div>

      {/* High contrast toggle */}
      <div className={styles.a11yGroup}>
        <button
          id="a11y-high-contrast"
          className={`${styles.a11yBtn} ${highContrast ? styles.a11yBtnActive : ''}`}
          onClick={handleHighContrastToggle}
          aria-pressed={highContrast}
          aria-label={highContrast ? 'Disable high contrast mode' : 'Enable high contrast mode'}
        >
          {highContrast ? '◑ High Contrast: ON' : '◑ High Contrast: OFF'}
        </button>
      </div>
    </div>
  );
}
