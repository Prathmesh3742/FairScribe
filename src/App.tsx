import React, { useState } from 'react';
import { ExamSessionProvider } from './state/examSession';
import InvigilatorUnlock from './screens/InvigilatorUnlock';
import Login from './screens/Login';
import Instructions from './screens/Instructions';
import QuestionPaper from './screens/QuestionPaper';
import './styles/global.css';

/**
 * App screen routing states (one-directional — no back navigation):
 *
 *   invigilator-unlock → login → instructions → exam
 *
 * Screen transitions are one-directional — there is no "back" navigation.
 * The only way to return to an earlier screen is to restart the app
 * (which requires invigilator authorization to unlock).
 *
 * Phase 3 adds 'instructions' between login and exam:
 *   - Kiosk mode is activated at login (unchanged from Phase 1/2).
 *   - The Instructions screen renders inside the already-active kiosk window.
 *   - The candidate must acknowledge instructions before reaching the exam.
 */
type Screen = 'invigilator-unlock' | 'login' | 'instructions' | 'exam';

export default function App() {
  const [screen, setScreen] = useState<Screen>('invigilator-unlock');

  return (
    <ExamSessionProvider>
      {screen === 'invigilator-unlock' && (
        <InvigilatorUnlock onUnlocked={() => setScreen('login')} />
      )}
      {screen === 'login' && (
        <Login onLoginSuccess={() => setScreen('instructions')} />
      )}
      {screen === 'instructions' && (
        <Instructions onProceed={() => setScreen('exam')} />
      )}
      {screen === 'exam' && (
        <QuestionPaper />
      )}
    </ExamSessionProvider>
  );
}
