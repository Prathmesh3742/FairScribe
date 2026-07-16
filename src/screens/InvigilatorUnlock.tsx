import React, { useState, useRef, useEffect } from 'react';
import styles from '../styles/InvigilatorUnlock.module.css';

interface Props {
  onUnlocked: () => void;
}

/**
 * InvigilatorUnlock — Phase 1 Gate 1
 *
 * The very first screen shown on app launch (non-kiosk mode).
 * The invigilator must enter the correct PIN before the candidate
 * sees the Login screen.
 *
 * PROTOTYPE: PIN is hardcoded as "0000" in electron/config.ts.
 * In a real deployment this would be a per-session PIN issued by
 * the exam authority. See README §Known Limitations.
 */
export default function InvigilatorUnlock({ onUnlocked }: Props) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isChecking) return;

    setIsChecking(true);
    setError(null);

    try {
      const valid = await window.fairscribe.auth.verifyPin(pin);
      if (valid) {
        onUnlocked();
      } else {
        setError('Incorrect PIN. Please try again.');
        setPin('');
        inputRef.current?.focus();
      }
    } catch {
      setError('System error. Please contact the invigilator.');
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        {/* Blue header strip */}
        <div className={styles.cardHeader}>
          <div className={styles.logoMark}>FS</div>
          <h1 className={styles.title}>FairScribe</h1>
          <p className={styles.subtitle}>Secure Examination Terminal</p>
        </div>

        {/* Card body */}
        <div className={styles.cardBody}>
          <div className={styles.gateLabel}>
            <span className={styles.gateBadge}>INVIGILATOR</span>
            <span className={styles.gateDesc}>Enter authorization PIN to begin</span>
          </div>

          <form onSubmit={handleSubmit} className={styles.form} noValidate>
            <div className={styles.fieldGroup}>
              <label htmlFor="invig-pin" className={styles.label}>
                Invigilator PIN
              </label>
              <input
                ref={inputRef}
                id="invig-pin"
                type="password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                maxLength={8}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className={`${styles.input} ${error ? styles.inputError : ''}`}
                placeholder="••••••••"
                aria-describedby={error ? 'invig-pin-error' : undefined}
                aria-invalid={error ? 'true' : 'false'}
                disabled={isChecking}
              />
              {error && (
                <p id="invig-pin-error" className={styles.errorMsg} role="alert">
                  {error}
                </p>
              )}
            </div>

            <button
              type="submit"
              className={styles.submitBtn}
              disabled={pin.length === 0 || isChecking}
            >
              {isChecking ? 'Verifying…' : 'Unlock Terminal'}
            </button>
          </form>

          <p className={styles.disclaimer}>
            This terminal is for authorized examination use only.
            Unauthorized access is prohibited.
          </p>
        </div>
      </div>
    </div>

  );
}
