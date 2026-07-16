import React, { useState, useRef, useEffect } from 'react';
import { useExamSession } from '../state/examSession';
import styles from '../styles/Login.module.css';

interface Props {
  onLoginSuccess: () => void;
}

/**
 * Login — Phase 1 Gate 2
 *
 * Candidate authentication screen shown after the invigilator
 * has unlocked the terminal. The student enters their studentId
 * and accessCode.
 *
 * On success:
 *   1. Session context is populated with student + exam data.
 *   2. kiosk:activate is called → main process switches window to
 *      kiosk mode in-place (React state is preserved).
 *   3. exam:loadQuestionPaper is called to hash + cache the paper.
 *   4. onLoginSuccess() transitions the app to the exam screen.
 *
 * On failure:
 *   - AuditLog entry is written by the main process (login_failure).
 *   - Inline error is shown. Retry is allowed (no lockout for prototype).
 */
export default function Login({ onLoginSuccess }: Props) {
  const { setSession } = useExamSession();
  const [studentId, setStudentId] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const studentIdRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    studentIdRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoggingIn) return;

    setIsLoggingIn(true);
    setError(null);

    try {
      const result = await window.fairscribe.auth.login(studentId.trim(), accessCode);

      if (!result) {
        setError('Invalid Student ID or access code. Please check your credentials and try again.');
        setAccessCode('');
        studentIdRef.current?.focus();
        return;
      }

      // 1. Activate kiosk mode in-place (window reconfigures without restart)
      await window.fairscribe.kiosk.activate();

      // 2. Load + hash the question paper
      const paperData = await window.fairscribe.exam.loadQuestionPaper(result.exam.examId);

      // 3. Populate session context (React state survives in-place kiosk switch)
      setSession({
        studentId: result.student.studentId,
        studentName: result.student.name,
        examId: result.exam.examId,
        examTitle: result.exam.examTitle,
        duration: result.exam.duration,
        questions: paperData.questions,
        currentQuestionIndex: 0,
      });

      // 4. Transition to exam screen
      onLoginSuccess();
    } catch {
      setError('A system error occurred. Please contact the invigilator.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.card}>
        {/* Blue header strip */}
        <div className={styles.header}>
          <div className={styles.logoMark}>FS</div>
          <h1 className={styles.title}>FairScribe</h1>
          <p className={styles.subtitle}>Candidate Login</p>
        </div>

        {/* Form body */}
        <div className={styles.formBody}>
          <form onSubmit={handleSubmit} className={styles.form} noValidate>
            {/* Student ID */}
            <div className={styles.fieldGroup}>
              <label htmlFor="student-id" className={styles.label}>
                Student ID
              </label>
              <input
                ref={studentIdRef}
                id="student-id"
                type="text"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className={`${styles.input} ${error ? styles.inputError : ''}`}
                placeholder="e.g. STU-2024-001"
                aria-describedby={error ? 'login-error' : undefined}
                aria-invalid={error ? 'true' : 'false'}
                disabled={isLoggingIn}
              />
            </div>

            {/* Access Code */}
            <div className={styles.fieldGroup}>
              <label htmlFor="access-code" className={styles.label}>
                Access Code
              </label>
              <input
                id="access-code"
                type="password"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                autoComplete="off"
                className={`${styles.input} ${error ? styles.inputError : ''}`}
                placeholder="Enter your access code"
                aria-describedby={error ? 'login-error' : undefined}
                aria-invalid={error ? 'true' : 'false'}
                disabled={isLoggingIn}
              />
            </div>

            {/* Error */}
            {error && (
              <p id="login-error" className={styles.errorMsg} role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              id="login-submit"
              className={styles.submitBtn}
              disabled={studentId.trim().length === 0 || accessCode.length === 0 || isLoggingIn}
            >
              {isLoggingIn ? 'Signing in…' : 'Begin Examination'}
            </button>
          </form>

          <p className={styles.note}>
            If you are unable to log in, please notify the invigilator immediately.
            Do not attempt multiple logins.
          </p>
        </div>
      </div>
    </div>
  );
}
