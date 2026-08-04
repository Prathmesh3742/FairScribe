/**
 * ttsService.ts — Offline Text-to-Speech Service
 *
 * Thin wrapper around the browser's built-in speechSynthesis API.
 * Uses offline voices pre-installed on Windows 10/11 (Microsoft David,
 * Microsoft Zira, etc.). No cloud APIs, no network dependency.
 *
 * Provides high-level methods for exam-specific speech needs:
 *   - readQuestion() — reads a question with appropriate pacing
 *   - announce() — short system announcements
 *   - speak() — general-purpose speech
 *   - stop() — cancel any current speech
 */

// ---------------------------------------------------------------------------
// Voice Selection
// ---------------------------------------------------------------------------

/**
 * Select the best available offline English voice.
 * Prefers Microsoft voices on Windows which are always available offline.
 * Falls back to any English voice, then any available voice.
 */
function selectVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  // Prefer Microsoft offline voices (Windows 10/11)
  const microsoftEnglish = voices.find(
    (v) => v.lang.startsWith('en') && v.name.includes('Microsoft') && !v.name.includes('Online')
  );
  if (microsoftEnglish) return microsoftEnglish;

  // Fallback: any English voice
  const anyEnglish = voices.find((v) => v.lang.startsWith('en'));
  if (anyEnglish) return anyEnglish;

  // Last resort: first available voice
  return voices[0] ?? null;
}

// Cache the selected voice (recomputed if voices change)
let cachedVoice: SpeechSynthesisVoice | null = null;
let voicesLoaded = false;

function getVoice(): SpeechSynthesisVoice | null {
  if (!voicesLoaded) {
    cachedVoice = selectVoice();
    if (cachedVoice) voicesLoaded = true;
  }
  return cachedVoice;
}

// Voices may load asynchronously — listen for the event
if (typeof window !== 'undefined' && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = selectVoice();
    voicesLoaded = true;
  };
  // Initial attempt (some browsers load voices synchronously)
  cachedVoice = selectVoice();
  if (cachedVoice) voicesLoaded = true;
}

// ---------------------------------------------------------------------------
// TTS State
// ---------------------------------------------------------------------------

let isSpeaking = false;

/**
 * Check if TTS is currently speaking.
 */
export function getIsSpeaking(): boolean {
  return isSpeaking || (typeof window !== 'undefined' && window.speechSynthesis?.speaking);
}

/**
 * Check if the speechSynthesis API is available and has voices.
 */
export function isTTSAvailable(): boolean {
  return typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    window.speechSynthesis.getVoices().length > 0;
}

// ---------------------------------------------------------------------------
// Core Speech Functions
// ---------------------------------------------------------------------------

/**
 * Speak arbitrary text. Returns a promise that resolves when speech ends.
 *
 * @param text - Text to speak
 * @param rate - Speech rate (0.5–2.0, default 1.0)
 * @param pitch - Speech pitch (0.5–2.0, default 1.0)
 */
export function speak(text: string, rate = 1.0, pitch = 1.0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) {
      resolve();
      return;
    }

    // Cancel any current speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = getVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = 1.0;
    utterance.lang = 'en-US';

    utterance.onstart = () => {
      isSpeaking = true;
    };

    utterance.onend = () => {
      isSpeaking = false;
      resolve();
    };

    utterance.onerror = (event) => {
      isSpeaking = false;
      // 'interrupted' and 'canceled' are expected when stop() is called
      if (event.error === 'interrupted' || event.error === 'canceled') {
        resolve();
      } else {
        console.warn('[TTS] Speech error:', event.error);
        resolve(); // Don't reject — TTS errors should not break the exam flow
      }
    };

    window.speechSynthesis.speak(utterance);
  });
}

/**
 * Stop any current speech immediately.
 */
export function stop(): void {
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    isSpeaking = false;
  }
}

// ---------------------------------------------------------------------------
// High-Level Exam Functions
// ---------------------------------------------------------------------------

/**
 * Read a question aloud with appropriate pacing.
 * Uses a slightly slower rate for clarity.
 *
 * @param questionText - The full question text
 * @param questionNumber - The question number for announcement
 */
export async function readQuestion(
  questionText: string,
  questionNumber?: number
): Promise<void> {
  const prefix = questionNumber != null
    ? `Question ${questionNumber}. `
    : '';

  await speak(prefix + questionText, 0.9, 1.0);
}

/**
 * Short system announcement (e.g., "Recording started", "Question 3").
 * Uses a slightly faster rate and doesn't interrupt question reading.
 *
 * @param message - Brief announcement text
 */
export async function announce(message: string): Promise<void> {
  await speak(message, 1.05, 1.0);
}

/**
 * Announce the current voice mode change.
 */
export async function announceMode(mode: string): Promise<void> {
  const modeMessages: Record<string, string> = {
    command_listening: 'Command mode active. Ready for voice commands.',
    dictation_recording: 'Recording started. Speak your answer now.',
    dictation_paused: 'Recording paused.',
    processing: 'Processing your answer.',
    confirming_submit: 'You are about to submit your examination. Say confirm submit to finalize, or cancel to return.',
  };

  const message = modeMessages[mode];
  if (message) {
    await announce(message);
  }
}

/**
 * Announce a command feedback message.
 */
export async function announceCommand(commandLabel: string): Promise<void> {
  await speak(commandLabel, 1.1, 1.0);
}

/**
 * Read the current answer aloud so the candidate can review and correct.
 * Uses a slightly slower rate for clarity.
 *
 * @param answerText - The answer text to read
 */
export async function readAnswer(answerText: string): Promise<void> {
  if (!answerText.trim()) {
    await announce('No answer text to read.');
    return;
  }
  await speak('Your answer reads: ' + answerText, 0.9, 1.0);
}

/**
 * Read all voice commands aloud, organized by category.
 * Enables fully hands-free discovery of available commands.
 *
 * @param commandsByCategory - Commands grouped by category name
 */
export async function readCommandList(
  commandsByCategory: Record<string, { phrase: string; description: string }[]>
): Promise<void> {
  const parts: string[] = ['Here are the available voice commands.'];
  for (const [category, commands] of Object.entries(commandsByCategory)) {
    parts.push(`${category} commands.`);
    for (const cmd of commands) {
      parts.push(`Say "${cmd.phrase}" to ${cmd.description.toLowerCase()}.`);
    }
  }
  await speak(parts.join(' '), 0.95, 1.0);
}
