/**
 * commandMatcher.ts — Fuzzy Voice Command Matching
 *
 * Pure function module that matches spoken text (from STT transcript events)
 * against a registry of predefined voice commands. Uses Levenshtein distance
 * for fuzzy matching to handle STT imperfections (e.g., "stopp recording"
 * should match "stop recording").
 *
 * No side effects — purely transforms input text to a matched command or null.
 * The command registry is configurable and easy to extend.
 */

import type { VoiceCommandId, VoiceCommandDef, VoiceMode } from '../types/fairscribe';

// ---------------------------------------------------------------------------
// Command Registry
// ---------------------------------------------------------------------------

/**
 * All supported voice commands with their primary phrases, aliases,
 * and the modes in which they are active.
 *
 * To add a new command:
 *   1. Add the ID to the VoiceCommandId union in fairscribe.d.ts.
 *   2. Add an entry here with phrase, aliases, and activeModes.
 *   3. Add a handler in useVoiceCommandEngine.ts.
 */
export const COMMAND_REGISTRY: VoiceCommandDef[] = [
  {
    id: 'start_recording',
    label: 'Start Recording',
    phrase: 'start recording',
    aliases: ['begin recording', 'start dictation', 'begin dictation', 'start dictating'],
    activeModes: ['command_listening'],
    description: 'Begin dictating your answer',
    category: 'Recording',
  },
  {
    id: 'stop_recording',
    label: 'Stop Recording',
    phrase: 'stop recording',
    aliases: ['end recording', 'stop dictation', 'end dictation', 'finish recording', 'done recording', 'stop dictating'],
    activeModes: ['dictation_recording', 'dictation_paused'],
    description: 'Stop dictation and verify transcript',
    category: 'Recording',
  },
  {
    id: 'pause_recording',
    label: 'Pause Recording',
    phrase: 'pause recording',
    aliases: ['pause dictation', 'pause'],
    activeModes: ['dictation_recording'],
    description: 'Temporarily pause dictation',
    category: 'Recording',
  },
  {
    id: 'resume_recording',
    label: 'Resume Recording',
    phrase: 'resume recording',
    aliases: ['resume dictation', 'continue recording', 'continue dictation', 'resume'],
    activeModes: ['dictation_paused'],
    description: 'Resume dictation from pause',
    category: 'Recording',
  },
  {
    id: 'next_question',
    label: 'Next Question',
    phrase: 'next question',
    aliases: ['go next', 'move next', 'next'],
    activeModes: ['command_listening'],
    description: 'Save and navigate to the next question',
    category: 'Navigation',
  },
  {
    id: 'previous_question',
    label: 'Previous Question',
    phrase: 'previous question',
    aliases: ['go back', 'go previous', 'last question', 'previous'],
    activeModes: ['command_listening'],
    description: 'Navigate to the previous question',
    category: 'Navigation',
  },
  {
    id: 'next_section',
    label: 'Next Section',
    phrase: 'next section',
    aliases: ['go to next section', 'move to next section'],
    activeModes: ['command_listening'],
    description: 'Navigate to the next section',
    category: 'Navigation',
  },
  {
    id: 'previous_section',
    label: 'Previous Section',
    phrase: 'previous section',
    aliases: ['go to previous section', 'go back a section'],
    activeModes: ['command_listening'],
    description: 'Navigate to the previous section',
    category: 'Navigation',
  },
  {
    id: 'goto_question',
    label: 'Go to Question',
    phrase: 'go to question',
    aliases: ['question number', 'jump to question'],
    activeModes: ['command_listening'],
    description: 'Jump directly to a specific question by number',
    category: 'Navigation',
  },
  {
    id: 'goto_section',
    label: 'Go to Section',
    phrase: 'go to section',
    aliases: ['open section', 'move to section', 'jump to section', 'section number'],
    activeModes: ['command_listening'],
    description: 'Jump directly to a specific section by number',
    category: 'Navigation',
  },
  {
    id: 'read_question',
    label: 'Read Question',
    phrase: 'read question',
    aliases: ['read the question', 'read it', 'read aloud'],
    activeModes: ['command_listening'],
    description: 'Read the current question aloud',
    category: 'Review',
  },
  {
    id: 'repeat_question',
    label: 'Repeat Question',
    phrase: 'repeat question',
    aliases: ['repeat the question', 'say again', 'read again'],
    activeModes: ['command_listening'],
    description: 'Read the current question aloud again',
    category: 'Review',
  },
  {
    id: 'read_answer',
    label: 'Read Answer',
    phrase: 'read answer',
    aliases: ['read my answer', 'read back answer', 'read response'],
    activeModes: ['command_listening', 'dictation_paused'],
    description: 'Read the current answer aloud for review',
    category: 'Review',
  },
  {
    id: 'save_answer',
    label: 'Save Answer',
    phrase: 'save answer',
    aliases: ['save my answer', 'save response', 'save it'],
    activeModes: ['command_listening'],
    description: 'Save the current answer',
    category: 'Review',
  },
  {
    id: 'clear_answer',
    label: 'Clear Answer',
    phrase: 'clear answer',
    aliases: ['clear my answer', 'clear response', 'clear text', 'clear', 'erase answer', 'delete answer'],
    activeModes: ['command_listening', 'dictation_paused'],
    description: 'Clear the current answer text',
    category: 'Editing',
  },
  {
    id: 'new_line',
    label: 'New Line',
    phrase: 'new line',
    aliases: [
      'newline',
      'next line',
      'line break',
      'enter',
      'new paragraph',
      'next paragraph',
      'new lined',   // STT mishear
      'new lion',    // phonetic variant
      'nude line',   // accent variant
    ],
    activeModes: ['command_listening', 'dictation_recording', 'dictation_paused'],
    description: 'Insert a line break in the answer',
    category: 'Editing',
  },
  {
    id: 'delete_last_word',
    label: 'Delete Last Word',
    phrase: 'delete last word',
    aliases: [
      'remove last word',
      'backspace',
      'undo word',
      'delete word',
      'remove word',
    ],
    activeModes: ['command_listening', 'dictation_recording', 'dictation_paused'],
    description: 'Remove the most recently transcribed word',
    category: 'Editing',
  },
  {
    id: 'undo',
    label: 'Undo',
    phrase: 'undo',
    aliases: ['undo that', 'undo change'],
    activeModes: ['command_listening', 'dictation_paused'],
    description: 'Undo the last edit to the answer',
    category: 'Editing',
  },
  {
    id: 'redo',
    label: 'Redo',
    phrase: 'redo',
    aliases: ['redo that', 'redo change'],
    activeModes: ['command_listening', 'dictation_paused'],
    description: 'Redo a previously undone edit',
    category: 'Editing',
  },
  {
    id: 'mark_review',
    label: 'Mark for Review',
    phrase: 'mark for review',
    aliases: ['mark this question', 'flag for review', 'mark review'],
    activeModes: ['command_listening'],
    description: 'Mark the current question for review',
    category: 'Review',
  },
  {
    id: 'unmark_review',
    label: 'Unmark Review',
    phrase: 'unmark review',
    aliases: ['unmark this question', 'remove flag'],
    activeModes: ['command_listening'],
    description: 'Remove the review flag from the current question',
    category: 'Review',
  },
  {
    id: 'submit_exam',
    label: 'Submit Exam',
    phrase: 'submit exam',
    aliases: ['submit examination', 'submit my exam', 'finish exam', 'end exam', 'submit test'],
    activeModes: ['command_listening'],
    description: 'Submit the examination for grading',
    category: 'Submission',
  },
  {
    id: 'confirm_submit',
    label: 'Confirm Submit',
    phrase: 'confirm submit',
    aliases: ['yes submit', 'confirm', 'yes confirm', 'confirm submission'],
    activeModes: ['confirming_submit'],
    description: 'Confirm and finalize exam submission',
    category: 'Submission',
  },
  {
    id: 'cancel',
    label: 'Cancel',
    phrase: 'cancel',
    aliases: ['go back', 'never mind', 'cancel submit', 'no', 'cancel submission'],
    activeModes: ['confirming_submit'],
    description: 'Cancel the current action',
    category: 'Submission',
  },
  {
    id: 'view_commands',
    label: 'View Commands',
    phrase: 'view commands',
    aliases: ['show commands', 'help', 'voice help', 'list commands'],
    activeModes: ['command_listening', 'dictation_paused'],
    description: 'Show the voice command reference',
    category: 'Help',
  },
  {
    id: 'close_commands',
    label: 'Close Commands',
    phrase: 'close commands',
    aliases: ['hide commands', 'close help', 'dismiss commands'],
    activeModes: ['command_listening', 'dictation_paused'],
    description: 'Close the voice command reference',
    category: 'Help',
  },
  {
    id: 'read_commands',
    label: 'Read Commands',
    phrase: 'read commands',
    aliases: ['speak commands', 'read help'],
    activeModes: ['command_listening', 'dictation_paused'],
    description: 'Read all voice commands aloud',
    category: 'Help',
  },

  // ── Punctuation commands (active during dictation and command_listening) ──
  // These are inserted as symbols, not appended as text to the transcript.
  // They are handled as a special case — not routed through the standard
  // command switch but resolved in insertPunctuation().
  {
    id: 'insert_punctuation',
    label: 'Full Stop',
    phrase: 'full stop',
    aliases: ['period', 'dot'],
    activeModes: ['command_listening', 'dictation_recording', 'dictation_paused'],
    description: 'Insert a full stop (.) at the current position',
    category: 'Punctuation',
  },
];

// ---------------------------------------------------------------------------
// Punctuation Symbol Map
// ---------------------------------------------------------------------------

/**
 * Maps spoken punctuation phrases to their symbols.
 * Includes canonical forms, phonetic variations, accent variants, and common
 * STT misrecognitions (e.g., Vosk mishearing "comma" as "kama" or "coma").
 *
 * Order matters: longer / more specific phrases are matched first.
 * All entries are lowercase — matching is case-insensitive.
 */
export const PUNCTUATION_MAP: { phrase: string; symbol: string }[] = [
  // ── Full stop / period ──
  { phrase: 'full stop',         symbol: '.' },
  { phrase: 'fullstop',          symbol: '.' },  // merged (no space)
  { phrase: 'full stop please',  symbol: '.' },
  { phrase: 'period',            symbol: '.' },
  { phrase: 'dot',               symbol: '.' },
  { phrase: 'full stoop',        symbol: '.' },  // STT mishear
  { phrase: 'fool stop',         symbol: '.' },  // accent variant
  { phrase: 'full step',         symbol: '.' },  // common mishear

  // ── Question mark ──
  { phrase: 'question mark',     symbol: '?' },
  { phrase: 'questionmark',      symbol: '?' },
  { phrase: 'question marks',    symbol: '?' },
  { phrase: 'question market',   symbol: '?' },  // STT mishear
  { phrase: 'question mock',     symbol: '?' },  // accent variant
  { phrase: 'question mack',     symbol: '?' },

  // ── Exclamation mark ──
  { phrase: 'exclamation mark',  symbol: '!' },
  { phrase: 'exclamation point', symbol: '!' },
  { phrase: 'exclamation',       symbol: '!' },
  { phrase: 'exclamation mak',   symbol: '!' },  // mishear

  // ── Comma ──
  { phrase: 'comma',             symbol: ',' },
  { phrase: 'coma',              symbol: ',' },  // common STT mishear
  { phrase: 'kama',              symbol: ',' },  // phonetic variant
  { phrase: 'kwama',             symbol: ',' },  // accent variant
  { phrase: 'come a',            symbol: ',' },  // split word mishear
  { phrase: 'como',              symbol: ',' },  // mishear

  // ── Semicolon ──
  { phrase: 'semicolon',         symbol: ';' },
  { phrase: 'semi colon',        symbol: ';' },
  { phrase: 'semi-colon',        symbol: ';' },
  { phrase: 'semi cologne',      symbol: ';' },  // STT mishear
  { phrase: 'semi colon please', symbol: ';' },

  // ── Colon ──
  { phrase: 'colon',             symbol: ':' },
  { phrase: 'collen',            symbol: ':' },  // accent variant
  { phrase: 'colen',             symbol: ':' },  // STT mishear
  { phrase: 'colleen',           symbol: ':' },  // mishear
  { phrase: 'cologne',           symbol: ':' },  // mishear

  // ── Hyphen / dash ──
  { phrase: 'hyphen',            symbol: '-' },
  { phrase: 'hiffen',            symbol: '-' },  // accent variant
  { phrase: 'hyfin',             symbol: '-' },  // STT mishear
  { phrase: 'hybrid',            symbol: '-' },  // mishear
  { phrase: 'dash',              symbol: '-' },
  { phrase: 'en dash',           symbol: '-' },

  // ── Apostrophe ──
  { phrase: 'apostrophe',        symbol: "'" },
  { phrase: 'apostrophy',        symbol: "'" },  // common misspelling/mishear
  { phrase: 'apostrophes',       symbol: "'" },
  { phrase: 'apostrophe please', symbol: "'" },
  { phrase: 'single quote',      symbol: "'" },

  // ── Parentheses ──
  { phrase: 'open parenthesis',  symbol: '(' },
  { phrase: 'open parentheses',  symbol: '(' },
  { phrase: 'open bracket',      symbol: '(' },  // common informal usage
  { phrase: 'open paren',        symbol: '(' },
  { phrase: 'close parenthesis', symbol: ')' },
  { phrase: 'close parentheses', symbol: ')' },
  { phrase: 'close bracket',     symbol: ')' },
  { phrase: 'close paren',       symbol: ')' },

  // ── Square brackets ──
  { phrase: 'open square bracket',   symbol: '[' },
  { phrase: 'close square bracket',  symbol: ']' },
  { phrase: 'open square',           symbol: '[' },
  { phrase: 'close square',          symbol: ']' },

  // ── Quotation marks ──
  { phrase: 'open quote',        symbol: '"' },
  { phrase: 'close quote',       symbol: '"' },
  { phrase: 'double quote',      symbol: '"' },
  { phrase: 'open quotes',       symbol: '"' },
  { phrase: 'close quotes',      symbol: '"' },

  // ── Ellipsis ──
  { phrase: 'ellipsis',          symbol: '\u2026' },
  { phrase: 'dot dot dot',       symbol: '\u2026' },
  { phrase: 'three dots',        symbol: '\u2026' },

  // ── Ampersand ──
  { phrase: 'ampersand',         symbol: '&' },
  { phrase: 'and sign',          symbol: '&' },
  { phrase: 'at sign',           symbol: '@' },
  { phrase: 'at symbol',         symbol: '@' },
];

/**
 * Spoken command → symbol lookup for the voice engine's insertPunctuation handler.
 * Keyed by the lowercased spoken phrase.
 */
export const PUNCTUATION_PHRASE_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  PUNCTUATION_MAP.map(({ phrase, symbol }) => [phrase, symbol])
);

// ---------------------------------------------------------------------------
// Levenshtein Distance
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein edit distance between two strings.
 * Used for fuzzy command matching to tolerate STT transcription errors.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Compute a normalized similarity score (0–1) between two strings.
 * 1.0 = exact match, 0.0 = completely different.
 */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - levenshteinDistance(a, b) / maxLen;
}

// ---------------------------------------------------------------------------
// Command Matching
// ---------------------------------------------------------------------------

/**
 * Maximum allowed Levenshtein distance as a fraction of phrase length.
 * Raised to 0.74 (from 0.72) to reduce false command detection during dictation.
 */
const FUZZY_THRESHOLD = 0.74;

/**
 * Exact match bonus — if the transcript contains the exact phrase as a
 * substring, give it maximum confidence regardless of fuzzy score.
 */
const EXACT_MATCH_CONFIDENCE = 1.0;

/**
 * Result of a command match attempt.
 */
export interface MatchResult {
  commandId: VoiceCommandId;
  confidence: number;
  matchedPhrase: string;
}

/**
 * Normalize text for matching: lowercase, collapse whitespace, trim.
 * Strips punctuation to ensure clean comparisons.
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Attempt to match the given transcript text against all commands
 * that are active in the specified voice mode.
 *
 * Returns the best matching command, or null if no match meets the threshold.
 *
 * @param text - Raw transcript text from STT
 * @param currentMode - Current voice engine mode
 * @returns Best match or null
 */
export function matchCommand(
  text: string,
  currentMode: VoiceMode
): MatchResult | null {
  const normalized = normalize(text);
  if (normalized.length < 2) return null;

  // Punctuation commands are handled separately via insertPunctuation — skip them here
  // so they don't pollute the command match results during dictation.
  const modeCommands = COMMAND_REGISTRY.filter(
    (cmd) => cmd.activeModes.includes(currentMode) && cmd.id !== 'insert_punctuation'
  );

  let bestMatch: MatchResult | null = null;

  for (const cmd of modeCommands) {
    const allPhrases = [cmd.phrase, ...cmd.aliases];

    for (const phrase of allPhrases) {
      const normalizedPhrase = normalize(phrase);

      // Exact substring match — highest confidence
      if (normalized.includes(normalizedPhrase)) {
        const confidence = EXACT_MATCH_CONFIDENCE;
        if (!bestMatch || confidence > bestMatch.confidence ||
            (confidence === bestMatch.confidence && normalizedPhrase.length > bestMatch.matchedPhrase.length)) {
          bestMatch = { commandId: cmd.id, confidence, matchedPhrase: phrase };
        }
        continue;
      }

      // Fuzzy match — compare the tail of the transcript against the phrase.
      // STT may prepend partial words before the command phrase.
      const words = normalized.split(' ');
      const phraseWords = normalizedPhrase.split(' ');

      // Sliding window: check all sub-sequences of the same length as the phrase
      if (words.length >= phraseWords.length) {
        for (let i = 0; i <= words.length - phraseWords.length; i++) {
          const window = words.slice(i, i + phraseWords.length).join(' ');
          const score = similarity(window, normalizedPhrase);

          if (score >= FUZZY_THRESHOLD) {
            if (!bestMatch || score > bestMatch.confidence) {
              bestMatch = { commandId: cmd.id, confidence: score, matchedPhrase: phrase };
            }
          }
        }
      }

      // Also try matching the entire normalized text against the phrase directly
      // (handles single-word commands like "cancel", "pause", "resume", "next")
      if (phraseWords.length === 1) {
        for (const word of words) {
          const score = similarity(word, normalizedPhrase);
          if (score >= FUZZY_THRESHOLD) {
            if (!bestMatch || score > bestMatch.confidence) {
              bestMatch = { commandId: cmd.id, confidence: score, matchedPhrase: phrase };
            }
          }
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Get all commands that are active in the given mode.
 * Used by the UI to display context-sensitive command suggestions.
 */
export function getActiveCommands(mode: VoiceMode): VoiceCommandDef[] {
  return COMMAND_REGISTRY.filter((cmd) => cmd.activeModes.includes(mode));
}

/**
 * Check if a given transcript text contains any command phrase.
 * Used by DictationPanel to filter commands out of the answer transcript.
 *
 * Returns true if the text appears to be a voice command rather than
 * normal dictation content.
 */
export function textContainsCommand(text: string): boolean {
  const normalized = normalize(text);
  if (normalized.length < 3) return false;

  for (const cmd of COMMAND_REGISTRY) {
    // Check commands that could appear during dictation or paused modes
    if (!cmd.activeModes.includes('dictation_recording') &&
        !cmd.activeModes.includes('dictation_paused')) continue;

    const allPhrases = [cmd.phrase, ...cmd.aliases];
    for (const phrase of allPhrases) {
      const normalizedPhrase = normalize(phrase);
      if (normalized.includes(normalizedPhrase)) return true;
      if (similarity(normalized, normalizedPhrase) >= 0.85) return true;
    }
  }

  return false;
}

/**
 * Strips command phrases from dictated text to prevent them from
 * appearing in the answer. Uses fuzzy sliding window matching.
 *
 * Preserves the original casing of non-command words.
 */
export function stripCommandPhrases(text: string): string {
  if (!text.trim()) return text;

  // Split on spaces, keeping the original-cased words in a parallel array
  const originalWords = text.split(' ');
  const normalizedWords = originalWords.map(w => normalize(w));

  // Mark positions that belong to a command match
  const masked = new Array<boolean>(originalWords.length).fill(false);

  // Strip commands that can be spoken during dictation or paused modes
  const dictationCommands = COMMAND_REGISTRY.filter(cmd =>
    cmd.activeModes.includes('dictation_recording') ||
    cmd.activeModes.includes('dictation_paused')
  );

  for (const cmd of dictationCommands) {
    const allPhrases = [cmd.phrase, ...cmd.aliases];
    for (const phrase of allPhrases) {
      const phraseNorm = normalize(phrase);
      const phraseWords = phraseNorm.split(' ');
      const phraseLen = phraseWords.length;

      // Sliding window
      if (normalizedWords.length >= phraseLen) {
        for (let i = 0; i <= normalizedWords.length - phraseLen; i++) {
          const window = normalizedWords.slice(i, i + phraseLen).join(' ');
          if (similarity(window, phraseNorm) >= FUZZY_THRESHOLD) {
            for (let j = 0; j < phraseLen; j++) {
              masked[i + j] = true;
            }
          }
        }
      }

      // Single word phrases
      if (phraseLen === 1) {
        for (let i = 0; i < normalizedWords.length; i++) {
          if (normalizedWords[i] && similarity(normalizedWords[i], phraseNorm) >= FUZZY_THRESHOLD) {
            masked[i] = true;
          }
        }
      }
    }
  }

  // Reconstruct using ORIGINAL casing, skipping masked positions
  return originalWords
    .filter((_, i) => !masked[i])
    .join(' ')
    .trim()
    .replace(/\s{2,}/g, ' ');
}

// ---------------------------------------------------------------------------
// Parametric Command Support
// ---------------------------------------------------------------------------

/**
 * Map of spoken word numbers to digits.
 */
const WORD_NUMBERS: Record<string, number> = {
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
  'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
};

/**
 * Extract a numeric parameter from "go to question N" style commands.
 * Returns the question number or null if no match found.
 */
export function extractQuestionNumber(text: string): number | null {
  const normalized = normalize(text);
  const patterns = [
    /go to question (\d+|[a-z]+)/,
    /question number (\d+|[a-z]+)/,
    /jump to question (\d+|[a-z]+)/,
    /open question (\d+|[a-z]+)/,
  ];
  for (const pat of patterns) {
    const m = normalized.match(pat);
    if (m) {
      const matchText = m[1];
      if (/^\d+$/.test(matchText)) {
        return parseInt(matchText, 10);
      } else if (WORD_NUMBERS[matchText]) {
        return WORD_NUMBERS[matchText];
      }
    }
  }
  return null;
}

/**
 * Extract a numeric parameter from "go to section N" / "open section N" style commands.
 * Returns the section number (1-based) or null if no match found.
 */
export function extractSectionNumber(text: string): number | null {
  const normalized = normalize(text);
  const patterns = [
    /go to section (\d+|[a-z]+)/,
    /open section (\d+|[a-z]+)/,
    /move to section (\d+|[a-z]+)/,
    /jump to section (\d+|[a-z]+)/,
    /section number (\d+|[a-z]+)/,
  ];
  for (const pat of patterns) {
    const m = normalized.match(pat);
    if (m) {
      const matchText = m[1];
      if (/^\d+$/.test(matchText)) {
        return parseInt(matchText, 10);
      } else if (WORD_NUMBERS[matchText]) {
        return WORD_NUMBERS[matchText];
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Punctuation Post-processing
// ---------------------------------------------------------------------------

/**
 * Replace spoken punctuation commands within a raw dictation transcript.
 *
 * Handles both stand-alone command phrases and inline usage, e.g.:
 *   "Hello world full stop How are you question mark"
 *   → "Hello world. How are you?"
 *
 * Rules:
 *   - Sentence-ending punctuation (. ? ! …) capitalizes the next word.
 *   - Attaching punctuation (, ; :) does NOT capitalize the next word.
 *   - Hyphens join words without spaces: "well hyphen known" → "well-known"
 *   - Brackets/parentheses/quotes keep their surrounding spaces intact.
 *
 * Does not alter newline characters already present in the text.
 */
export function replacePunctuationCommands(text: string): string {
  if (!text) return text;

  // Sort by phrase length descending so longer phrases match first.
  const sorted = [...PUNCTUATION_MAP].sort((a, b) => b.phrase.length - a.phrase.length);

  // We work word-by-word to preserve newlines.
  // Split on newlines first, process each line, then rejoin.
  const lines = text.split('\n');
  const processedLines = lines.map((line) => processLine(line, sorted));
  return processedLines.join('\n');
}

/** Sentence-ending punctuation that triggers next-word capitalization. */
const SENTENCE_ENDING = new Set(['.', '?', '!', '…']);

/** Punctuation that attaches without a leading space. */
const NO_LEADING_SPACE = new Set(['.', ',', ';', ':', '?', '!', '…', '-', ')', ']', '"']);

/** Punctuation that attaches without a trailing space. */
const NO_TRAILING_SPACE = new Set(['-', '(', '[', '"']);

function processLine(line: string, sorted: typeof PUNCTUATION_MAP): string {
  // Tokenize the line into words (split on spaces, keep empties trimmed)
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0) return line;

  const out: string[] = [];
  let capitalizeNext = false;
  let i = 0;

  // Fuzzy threshold for punctuation matching — slightly lower than command
  // threshold because punctuation phrases are short and distinct enough that
  // a 0.72 similarity is still unambiguous.
  const PUNCT_FUZZY_THRESHOLD = 0.72;

  while (i < words.length) {
    // Try to match a multi-word punctuation phrase starting at position i
    let matched = false;
    for (const { phrase, symbol } of sorted) {
      const phraseWords = phrase.split(' ');
      const len = phraseWords.length;
      if (i + len > words.length) continue;

      const candidate = words.slice(i, i + len).join(' ').toLowerCase();

      // First try exact match (fastest path)
      if (candidate === phrase) {
        out.push(symbol);
        capitalizeNext = SENTENCE_ENDING.has(symbol);
        i += len;
        matched = true;
        break;
      }

      // Then try fuzzy match — catches STT misrecognitions
      // e.g. "coma" matches "comma", "collen" matches "colon", "hiffen" matches "hyphen"
      const sim = similarity(candidate, phrase);
      if (sim >= PUNCT_FUZZY_THRESHOLD) {
        out.push(symbol);
        capitalizeNext = SENTENCE_ENDING.has(symbol);
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      let word = words[i];
      if (capitalizeNext && word.length > 0) {
        word = word.charAt(0).toUpperCase() + word.slice(1);
        capitalizeNext = false;
      }
      out.push(word);
      i++;
    }
  }

  // Now assemble the output string with correct spacing around punctuation
  let result = '';
  for (let j = 0; j < out.length; j++) {
    const token = out[j];
    const prevToken = out[j - 1] ?? '';
    const prevIsSymbol = PUNCTUATION_MAP.some(p => p.symbol === prevToken);

    if (j === 0) {
      result += token;
    } else if (NO_LEADING_SPACE.has(token)) {
      // Punctuation attaches directly to the preceding word
      result += token;
    } else if (prevIsSymbol && NO_TRAILING_SPACE.has(prevToken)) {
      // After opening bracket/paren/quote, no space before next word
      result += token;
    } else {
      result += ' ' + token;
    }
  }

  return result;
}


// ---------------------------------------------------------------------------
// STT Accuracy Helpers
// ---------------------------------------------------------------------------

/**
 * Remove consecutive duplicate words from Vosk transcripts.
 * Vosk frequently emits repeated words when audio has slight glitches:
 *   "the the quick brown brown fox" → "the quick brown fox"
 *
 * Works across both single-word and multi-word repetitions.
 * Preserves newlines and original casing.
 */
export function deduplicateRepeatedWords(text: string): string {
  if (!text) return text;

  // Process line by line to preserve newlines
  return text.split('\n').map(line => {
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length === 0) return line;

    const result: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const prev = result[result.length - 1];
      // Skip if same word as the previous (case-insensitive)
      if (prev && word.toLowerCase() === prev.toLowerCase()) continue;
      result.push(word);
    }
    return result.join(' ');
  }).join('\n');
}

/**
 * Ensure the first character of the text is capitalized.
 * Does not alter existing capitalization of subsequent words.
 */
export function capitalizeFirstLetter(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Category Grouping (for Voice Command Reference)
// ---------------------------------------------------------------------------

/**
 * Get all commands grouped by category.
 * Used by the VoiceCommandReference modal to display organized commands.
 */
export function getCommandsByCategory(): Record<string, VoiceCommandDef[]> {
  const groups: Record<string, VoiceCommandDef[]> = {};
  for (const cmd of COMMAND_REGISTRY) {
    const cat = cmd.category ?? 'Other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(cmd);
  }
  return groups;
}

/**
 * Get all punctuation entries with their spoken phrases and symbols.
 * Used by the command reference panel to display punctuation shortcuts.
 */
export function getPunctuationCommands(): { phrase: string; symbol: string }[] {
  return PUNCTUATION_MAP.map(({ phrase, symbol }) => ({ phrase, symbol }));
}
