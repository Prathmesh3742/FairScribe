import React, { useState } from 'react';
import { ExamSessionProvider } from './state/examSession';
import InvigilatorUnlock from './screens/InvigilatorUnlock';
import Login from './screens/Login';
import QuestionPaper from './screens/QuestionPaper';
import './styles/global.css';

/**
 * App screen routing states:
 *   invigilator-unlock → login → exam
 *
 * Screen transitions are one-directional — there is no "back" navigation.
 * The only way to return to an earlier screen is to restart the app
 * (which requires invigilator authorization to unlock).
 */
type Screen = 'invigilator-unlock' | 'login' | 'exam';

export default function App() {
  const [screen, setScreen] = useState<Screen>('invigilator-unlock');

  return (
    <ExamSessionProvider>
      {screen === 'invigilator-unlock' && (
        <InvigilatorUnlock onUnlocked={() => setScreen('login')} />
      )}
      {screen === 'login' && (
        <Login onLoginSuccess={() => setScreen('exam')} />
      )}
      {screen === 'exam' && (
        <QuestionPaper />
      )}
    </ExamSessionProvider>
  );
}
