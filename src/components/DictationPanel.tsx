import React, { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { DictationStatus, STTTranscriptEvent } from '../types/fairscribe';
import { stripCommandPhrases, matchCommand, replacePunctuationCommands, deduplicateRepeatedWords, capitalizeFirstLetter } from '../voice/commandMatcher';
import styles from '../styles/Dictation.module.css';

// ---------------------------------------------------------------------------
// Imperative handle — allows parent/voice engine to control recording
// ---------------------------------------------------------------------------

export interface DictationPanelHandle {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  clearTranscript: () => Promise<void>;
  newLine: () => void;
  deleteLastWord: () => void;
  /** Insert a punctuation symbol directly (without leading space for attaching chars). */
  insertPunctuation: (symbol: string) => void;
  undo: () => void;
  redo: () => void;
  getStatus: () => DictationStatus;
  getText: () => string;
  /** Returns true if the text undo history has items to undo. */
  canUndo: () => boolean;
}

/**
 * DictationPanel — Phase 3+: Real-time speech-to-text dictation UI
 *
 * Improvements in this version:
 *   - Formatting preservation: newlines survive stop/reload/autosave/submission.
 *     The transcript area renders \n as actual visual line breaks using <br/>.
 *   - Punctuation commands: replacePunctuationCommands() post-processes both
 *     Vosk live transcripts and Whisper verification results.
 *   - Whisper merge strategy: when Whisper returns a better transcript, existing
 *     \n markers are preserved by counting approximate paragraph boundaries.
 *   - STT deduplication: consecutive repeated words from Vosk are collapsed.
 *   - Capitalization preservation: stripCommandPhrases now keeps original casing.
 *   - insertPunctuation: new imperative method for voice punctuation commands.
 *
 * State machine (unchanged):
 *   idle → recording → paused → recording → ..
 *                    → processing → idle
 *                    → error → idle (retry)
 */

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DictationPanelProps {
  questionId: string;
  studentId: string;
  examId: string;
  /** Restored from DB on question revisit. */
  initialText: string;
  /** Callback when transcript changes (for parent to track). */
  onTranscriptChange: (text: string) => void;
  /** Callback when dictation status changes (for voice engine sync). */
  onStatusChange?: (status: DictationStatus) => void;
}

// ---------------------------------------------------------------------------
// Audio capture helpers
// ---------------------------------------------------------------------------

/** Target sample rate for the STT service. */
const TARGET_SAMPLE_RATE = 16000;

/**
 * Downsample a Float32Array from the browser's sample rate to 16kHz
 * and convert to 16-bit PCM (Int16Array).
 */
function downsampleAndConvert(
  input: Float32Array,
  inputSampleRate: number
): ArrayBuffer {
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.ceil(input.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.round(i * ratio);
    const sample = Math.max(-1, Math.min(1, input[srcIndex] ?? 0));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output.buffer;
}

/**
 * Compute RMS (root mean square) of a Float32Array for level metering.
 * Returns a value between 0 and 1.
 */
function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Punctuation symbols that attach to the preceding token without a space.
 * Used when appending new STT text to existing finalText.
 */
const ATTACHING_PUNCT = new Set(['.', ',', ';', ':', '?', '!', '…', ')', ']', '"']);

/**
 * Append new STT text to existing text with correct spacing.
 *
 * Rules:
 *   - If existing text ends with a newline, the new text starts on the same
 *     new line (no extra space).
 *   - If existing text is empty, return the new text directly.
 *   - If the new text starts with attaching punctuation, do not add a space.
 *   - Otherwise add a single space separator.
 */
function appendWithSpacing(existing: string, newText: string): string {
  if (!existing) return newText;
  if (!newText) return existing;

  const lastChar = existing[existing.length - 1];
  const firstChar = newText[0];

  // After a newline — no space needed, the cursor is already at column 0
  if (lastChar === '\n') return existing + newText;

  // Attaching punctuation (e.g. full stop) — no leading space
  if (ATTACHING_PUNCT.has(firstChar)) return existing + newText;

  return existing + ' ' + newText;
}

/**
 * Merge a Whisper-verified transcript into an existing text that may contain
 * \n line breaks inserted by the "new line" voice command.
 *
 * Strategy:
 *   - If the existing text has no \n, replace it entirely with Whisper's text.
 *   - If the existing text has \n markers:
 *       1. Split on \n to get the paragraph count (N segments).
 *       2. Split Whisper's text into approximately N segments by word count.
 *       3. Rejoin with \n to preserve paragraph structure.
 *   This is a best-effort merge — Whisper may reorder words, but the overall
 *   paragraph structure is maintained for the candidate's benefit.
 */
function mergeWhisperWithNewlines(existingText: string, whisperText: string): string {
  if (!whisperText.trim()) return existingText; // Whisper returned nothing — keep existing
  if (!existingText.includes('\n')) return whisperText; // No newlines — replace entirely

  const existingSegments = existingText.split('\n');
  const segmentCount = existingSegments.length;

  if (segmentCount <= 1) return whisperText;

  // Compute the approximate word count per segment in the existing text
  const existingTotalWords = existingText.replace(/\n/g, ' ').split(/\s+/).filter(Boolean).length;
  const whisperWords = whisperText.split(/\s+/).filter(Boolean);

  if (existingTotalWords === 0 || whisperWords.length === 0) return whisperText;

  // Compute target words per segment based on existing proportions
  const result: string[] = [];
  let wordCursor = 0;

  for (let i = 0; i < segmentCount; i++) {
    const segWords = existingSegments[i].split(/\s+/).filter(Boolean).length;
    // Proportion of this segment in total
    const proportion = existingTotalWords > 0 ? segWords / existingTotalWords : 1 / segmentCount;
    const wordsForSegment = i === segmentCount - 1
      ? whisperWords.length - wordCursor  // Last segment gets remainder
      : Math.round(proportion * whisperWords.length);

    const sliced = whisperWords.slice(wordCursor, wordCursor + wordsForSegment);
    result.push(sliced.join(' '));
    wordCursor += wordsForSegment;
  }

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Transcript rendering (newline-safe)
// ---------------------------------------------------------------------------

/**
 * Render the finalText + partialText into JSX, preserving \n as <br/> elements.
 * This solves the core formatting preservation bug where CSS white-space: pre-wrap
 * could be collapsed by certain rendering paths.
 */
function renderTranscriptContent(
  finalText: string,
  partialText: string,
  finalClass: string,
  partialClass: string
): React.ReactNode {
  const segments = finalText.split('\n');

  return (
    <>
      {segments.map((segment, idx) => (
        <React.Fragment key={idx}>
          <span className={finalClass}>{segment}</span>
          {idx < segments.length - 1 && <br />}
        </React.Fragment>
      ))}
      {partialText && (
        <>
          {finalText ? ' ' : ''}
          <span className={partialClass}>{partialText}</span>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DictationPanel = forwardRef<DictationPanelHandle, DictationPanelProps>(function DictationPanel({
  questionId,
  studentId,
  examId,
  initialText,
  onTranscriptChange,
  onStatusChange,
}, ref) {
  // ── State ──
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [finalText, setFinalText] = useState(initialText);
  const [partialText, setPartialText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  // ── Refs ──
  const sessionIdRef = useRef<string | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | AudioWorkletNode | null>(null);
  const unsubTranscriptRef = useRef<(() => void) | null>(null);
  const transcriptAreaRef = useRef<HTMLDivElement>(null);
  const finalTextRef = useRef(initialText);
  // Ref to hold the latest onTranscriptChange callback without causing re-renders.
  // The inline closure from QuestionPaper creates a new reference every render,
  // which would trigger the useEffect dependency and cause flickering.
  const onTranscriptChangeRef = useRef(onTranscriptChange);
  onTranscriptChangeRef.current = onTranscriptChange;

  // ── Undo/Redo history ──
  const MAX_HISTORY = 50;
  const historyRef = useRef<string[]>([initialText]);
  const historyIndexRef = useRef(0);
  /** Push a new state to the history, discarding any redo states. */
  const pushHistory = useCallback((text: string) => {
    const h = historyRef.current;
    const idx = historyIndexRef.current;
    // Discard any redo states beyond current index
    historyRef.current = h.slice(0, idx + 1);
    historyRef.current.push(text);
    // Enforce max history length
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current = historyRef.current.slice(historyRef.current.length - MAX_HISTORY);
    }
    historyIndexRef.current = historyRef.current.length - 1;
  }, []);

  // Keep ref in sync
  finalTextRef.current = finalText;

  // ── Sync initialText when question changes ──
  useEffect(() => {
    setFinalText(initialText);
    setPartialText('');
    finalTextRef.current = initialText;
    // Reset history for new question
    historyRef.current = [initialText];
    historyIndexRef.current = 0;
  }, [questionId, initialText]);

  // ── Auto-scroll transcript to bottom ──
  useEffect(() => {
    if (transcriptAreaRef.current) {
      transcriptAreaRef.current.scrollTop = transcriptAreaRef.current.scrollHeight;
    }
  }, [finalText, partialText]);

  // ── Notify parent when text changes ──
  // Uses a ref for the callback to avoid re-render cycles:
  // QuestionPaper passes an inline closure that creates a new reference
  // every render. If we put onTranscriptChange in the deps array, it
  // triggers this effect on every render → calls updateAnswerText →
  // creates new session object → re-renders QuestionPaper → new closure
  // → repeat = flickering.
  useEffect(() => {
    onTranscriptChangeRef.current(finalText);
  }, [finalText]);

  // ── Health check on mount ──
  // Run only once when the component mounts, not on every questionId change.
  // Re-running on each question navigation caused a null→true/false state
  // transition that triggered layout re-renders (flickering).
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const health = await window.fairscribe.stt.healthCheck();
        if (!cancelled) {
          setBackendOnline(health.status === 'ok' || health.status === 'degraded');
        }
      } catch {
        if (!cancelled) setBackendOnline(false);
      }
    };
    check();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Cleanup on unmount or question change ──
  useEffect(() => {
    return () => {
      stopCapture();
      if (unsubTranscriptRef.current) {
        unsubTranscriptRef.current();
        unsubTranscriptRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  // ── Word count ──
  const combinedText = finalText + (partialText ? ' ' + partialText : '');
  const wordCount = combinedText.trim() ? combinedText.trim().split(/\s+/).length : 0;

  // ---------------------------------------------------------------------------
  // STT text post-processing pipeline
  // ---------------------------------------------------------------------------

  /**
   * Apply the full post-processing pipeline to a raw STT transcript segment:
   *   1. Deduplicate consecutive repeated words (Vosk artifact)
   *   2. Replace spoken punctuation commands with symbols
   *   3. Strip any residual command phrases
   *   4. Ensure first letter is capitalized when appended to empty/newline context
   */
  const processTranscriptSegment = useCallback((
    rawText: string,
    isAtStart: boolean
  ): string => {
    // 1. Dedup repeated words
    let processed = deduplicateRepeatedWords(rawText);

    // 2. Replace punctuation commands
    processed = replacePunctuationCommands(processed);

    // 3. Strip command phrases (preserves original casing now)
    processed = stripCommandPhrases(processed);

    // 4. Capitalize if at start of text or after newline
    if (isAtStart && processed.length > 0) {
      processed = capitalizeFirstLetter(processed);
    }

    return processed.trim();
  }, []);

  // ---------------------------------------------------------------------------
  // Audio capture lifecycle
  // ---------------------------------------------------------------------------

  /** Start microphone capture + STT session. */
  const startRecording = useCallback(async () => {
    setError(null);

    try {
      // 1. Request microphone access
      //    IMPORTANT: Do NOT force sampleRate here — let the OS use its native
      //    rate (typically 44100 or 48000 Hz). Forcing 16kHz can crash Chromium's
      //    audio pipeline on some Windows audio drivers (0xC0000005).
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // 2. Create STT session on the Python backend
      const { sessionId } = await window.fairscribe.stt.startSession({
        studentId,
        examId,
        questionId,
      });
      sessionIdRef.current = sessionId;

      // 3. Subscribe to transcript events from main process
      if (unsubTranscriptRef.current) unsubTranscriptRef.current();
      unsubTranscriptRef.current = window.fairscribe.stt.onTranscript(
        (event: STTTranscriptEvent) => {
          if (event.sessionId !== sessionId) return;

          if (event.type === 'final' && event.text) {
            // ── Command Detection Gate (Critical Fix) ──
            // Check if this transcript matches a voice command that is active
            // during dictation. If so, discard it — the VoiceCommandEngine's
            // separate STT session will handle the command execution.
            const cmdMatchRec = matchCommand(event.text, 'dictation_recording');
            const cmdMatchPaused = matchCommand(event.text, 'dictation_paused');
            if ((cmdMatchRec && cmdMatchRec.confidence >= 0.70) ||
                (cmdMatchPaused && cmdMatchPaused.confidence >= 0.70)) {
              console.log('[DictationPanel] Suppressed command from transcript:', event.text);
              setPartialText('');
              return; // Do NOT append to finalText
            }

            // Determine if we're at the start of the text (for capitalization)
            const currentText = finalTextRef.current;
            const isAtStart = !currentText || currentText.endsWith('\n');

            const filteredText = processTranscriptSegment(event.text, isAtStart);
            if (filteredText) {
              setFinalText((prev) => {
                const next = appendWithSpacing(prev, filteredText);
                finalTextRef.current = next;
                pushHistory(next);
                return next;
              });
            }
            setPartialText('');
          } else if (event.type === 'partial') {
            // Apply punctuation replacement BEFORE command stripping for partials too.
            const filteredPartial = stripCommandPhrases(
              replacePunctuationCommands(event.text)
            );
            setPartialText(filteredPartial);
          }
        }
      );

      // 4. Set up AudioContext for PCM capture
      //    Use the NATIVE sample rate (44100/48000 Hz) — never force 16kHz.
      //    Forcing a non-native rate causes Chromium's internal resampler to
      //    crash with an access violation on certain Windows audio drivers.
      //    The downsampleAndConvert() function handles 48kHz→16kHz conversion
      //    in JavaScript, which is safe and portable.
      const audioCtx = new AudioContext();
      audioContextRef.current = audioCtx;
      const nativeSampleRate = audioCtx.sampleRate;
      console.log(`[DictationPanel] AudioContext created at native ${nativeSampleRate}Hz, will downsample to ${TARGET_SAMPLE_RATE}Hz`);

      const source = audioCtx.createMediaStreamSource(stream);

      // Use AudioWorkletNode (modern, stable) instead of deprecated
      // ScriptProcessorNode which causes native crashes (0xC0000005) in
      // Electron 28 on Windows.
      try {
        await audioCtx.audioWorklet.addModule('/pcm-processor.js');
        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
        processorNodeRef.current = workletNode;

        workletNode.port.onmessage = (e: MessageEvent) => {
          if (e.data?.type === 'audio' && e.data.samples) {
            const inputData: Float32Array = e.data.samples;

            // Level metering
            setAudioLevel(Math.min(1, computeRMS(inputData) * 5));

            // Downsample from native rate (44100/48000) → 16kHz + convert to 16-bit PCM
            const pcmBuffer = downsampleAndConvert(inputData, nativeSampleRate);

            // Send to main process → Python WebSocket
            if (sessionIdRef.current) {
              window.fairscribe.stt.sendAudio(sessionIdRef.current, pcmBuffer);
            }
          }
        };

        source.connect(workletNode);
        // AudioWorkletNode does NOT need to connect to destination
        console.log('[DictationPanel] Audio capture via AudioWorklet');
      } catch (workletErr) {
        // Fallback: ScriptProcessorNode (deprecated but widely supported)
        console.warn('[DictationPanel] AudioWorklet failed, falling back to ScriptProcessor:', workletErr);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorNodeRef.current = processor;

        processor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          setAudioLevel(Math.min(1, computeRMS(inputData) * 5));
          const pcmBuffer = downsampleAndConvert(inputData, nativeSampleRate);
          if (sessionIdRef.current) {
            window.fairscribe.stt.sendAudio(sessionIdRef.current, pcmBuffer);
          }
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
      }

      setStatus('recording');
      onStatusChange?.('recording');

      // Audit log
      await window.fairscribe.audit.logEvent('dictation_started', {
        questionId,
        sessionId,
      });

    } catch (err: any) {
      console.error('[DictationPanel] Start recording failed:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setError('Microphone access denied. Please grant microphone permission and try again.');
      } else if (err.name === 'NotFoundError') {
        setError('No microphone found. Please connect a microphone and try again.');
      } else {
        setError(err.message || 'Failed to start recording');
      }
      setStatus('error');
      onStatusChange?.('error');
      stopCapture();
    }
  }, [studentId, examId, questionId, processTranscriptSegment, pushHistory]);

  /** Stop microphone capture and release resources. */
  const stopCapture = useCallback(() => {
    // Stop audio processor node
    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      if ('onaudioprocess' in processorNodeRef.current) {
        (processorNodeRef.current as ScriptProcessorNode).onaudioprocess = null;
      }
      processorNodeRef.current = null;
    }

    // Close AudioContext
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    // Stop media tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    setAudioLevel(0);
  }, []);

  /** Pause recording (suspend AudioContext, keep session alive). */
  const pauseRecording = useCallback(async () => {
    if (audioContextRef.current && audioContextRef.current.state === 'running') {
      await audioContextRef.current.suspend();
    }
    setStatus('paused');
    onStatusChange?.('paused');
    setAudioLevel(0);

    await window.fairscribe.audit.logEvent('dictation_paused', {
      questionId,
      sessionId: sessionIdRef.current,
    });
  }, [questionId]);

  /** Resume recording from pause. */
  const resumeRecording = useCallback(async () => {
    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    setStatus('recording');
    onStatusChange?.('recording');

    await window.fairscribe.audit.logEvent('dictation_resumed', {
      questionId,
      sessionId: sessionIdRef.current,
    });
  }, [questionId]);

  /** Stop recording: close audio + get Whisper-verified transcript. */
  const stopRecording = useCallback(async () => {
    setStatus('processing');
    onStatusChange?.('processing');
    stopCapture();

    try {
      if (sessionIdRef.current) {
        const result = await window.fairscribe.stt.stopRecording(sessionIdRef.current);

        // Use Whisper transcript if available and non-empty.
        // CRITICAL: Merge with existing \n markers so paragraph formatting is preserved.
        if (result.whisperAvailable && result.finalTranscript) {
          // CRITICAL ORDER: replacePunctuation FIRST, then strip commands.
          // If we strip first, spoken punctuation words like "full stop" are
          // removed before they can be converted to their symbols.
          const filteredWhisper = deduplicateRepeatedWords(
            stripCommandPhrases(
              replacePunctuationCommands(result.finalTranscript)
            )
          );

          setFinalText((currentText) => {
            // If the current text has newlines, merge rather than replace wholesale.
            const merged = mergeWhisperWithNewlines(currentText, filteredWhisper);
            finalTextRef.current = merged;
            // Push the merged result to history so undo works.
            pushHistory(merged);
            return merged;
          });
        }

        await window.fairscribe.audit.logEvent('dictation_stopped', {
          questionId,
          sessionId: sessionIdRef.current,
          audioDuration: result.audioDurationSeconds,
          whisperUsed: result.whisperAvailable,
          whisperConfidence: result.whisperConfidence,
        });
      }
    } catch (err: any) {
      console.error('[DictationPanel] Stop recording failed:', err);
      // Keep the Vosk transcript we already have — don't lose it
    } finally {
      // Unsubscribe from transcript events
      if (unsubTranscriptRef.current) {
        unsubTranscriptRef.current();
        unsubTranscriptRef.current = null;
      }
      sessionIdRef.current = null;
      setPartialText('');
      setStatus('idle');
      onStatusChange?.('idle');
    }
  }, [questionId, stopCapture, pushHistory]);

  /** Clear all transcript text. */
  const clearTranscript = useCallback(async () => {
    setFinalText('');
    setPartialText('');
    finalTextRef.current = '';
    pushHistory('');

    await window.fairscribe.audit.logEvent('dictation_cleared', { questionId });
  }, [questionId, pushHistory]);

  // ---------------------------------------------------------------------------
  // Imperative handle — voice engine can call these methods directly
  // ---------------------------------------------------------------------------

  useImperativeHandle(ref, () => ({
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    clearTranscript,
    newLine: () => {
      setFinalText((prev) => {
        // Append \n. If the text already ends with \n, don't double-newline.
        const next = prev.endsWith('\n') ? prev : prev + '\n';
        finalTextRef.current = next;
        pushHistory(next);
        return next;
      });
    },
    deleteLastWord: () => {
      setFinalText((prev) => {
        // Handle newline boundary: if text ends with \n, remove the newline first.
        if (prev.endsWith('\n')) {
          const next = prev.slice(0, -1);
          finalTextRef.current = next;
          pushHistory(next);
          return next;
        }
        const trimmed = prev.trimEnd();
        const lastSpaceIdx = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\n'));
        const next = lastSpaceIdx >= 0 ? trimmed.slice(0, lastSpaceIdx) : '';
        finalTextRef.current = next;
        pushHistory(next);
        return next;
      });
    },
    insertPunctuation: (symbol: string) => {
      setFinalText((prev) => {
        // Punctuation attaches without a leading space for attaching symbols
        const next = ATTACHING_PUNCT.has(symbol) ? prev + symbol : prev + ' ' + symbol;
        finalTextRef.current = next;
        pushHistory(next);
        return next;
      });
    },
    undo: () => {
      const idx = historyIndexRef.current;
      if (idx > 0) {
        historyIndexRef.current = idx - 1;
        const text = historyRef.current[idx - 1];
        setFinalText(text);
        finalTextRef.current = text;
      }
    },
    redo: () => {
      const idx = historyIndexRef.current;
      if (idx < historyRef.current.length - 1) {
        historyIndexRef.current = idx + 1;
        const text = historyRef.current[idx + 1];
        setFinalText(text);
        finalTextRef.current = text;
      }
    },
    canUndo: () => historyIndexRef.current > 0,
    getStatus: () => status,
    getText: () => finalTextRef.current,
  }), [startRecording, stopRecording, pauseRecording, resumeRecording, clearTranscript, pushHistory, status]);

  // ---------------------------------------------------------------------------
  // Auto-stop on question change (if recording)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      // If we're still recording when the question changes, auto-stop
      if (sessionIdRef.current) {
        // Fire-and-forget — the cleanup will handle resources
        window.fairscribe.stt.stopRecording(sessionIdRef.current).catch(() => {});
        sessionIdRef.current = null;
      }
      stopCapture();
      if (unsubTranscriptRef.current) {
        unsubTranscriptRef.current();
        unsubTranscriptRef.current = null;
      }
      setStatus('idle');
      onStatusChange?.('idle');
      setPartialText('');
      setAudioLevel(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isRecording = status === 'recording';
  const isPaused = status === 'paused';
  const isProcessing = status === 'processing';
  const isIdle = status === 'idle';
  const isError = status === 'error';

  const hasText = combinedText.trim().length > 0;

  // Status pill class
  const statusClass = isRecording ? styles.statusRecording
    : isPaused ? styles.statusPaused
    : isProcessing ? styles.statusProcessing
    : isError ? styles.statusError
    : styles.statusIdle;

  const statusLabel = isRecording ? 'Recording'
    : isPaused ? 'Paused'
    : isProcessing ? 'Processing'
    : isError ? 'Error'
    : 'Ready';

  return (
    <div className={styles.panel} aria-label="Dictation panel">
      {/* ── Error banner ── */}
      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>⚠ {error}</span>
          <button onClick={() => { setError(null); setStatus('idle'); }}>
            Dismiss
          </button>
        </div>
      )}

      {/* ── Controls bar ── */}
      <div className={styles.controlsBar}>
        {/* Status pill */}
        <div
          className={`${styles.statusPill} ${statusClass}`}
          aria-live="polite"
          aria-atomic="true"
          aria-label={`Dictation status: ${statusLabel}`}
        >
          <span className={styles.statusDot} aria-hidden="true" />
          {statusLabel}
        </div>

        {/* Record / Pause / Resume / Stop buttons */}
        {isIdle || isError ? (
          <button
            className={`${styles.controlBtn} ${styles.btnRecord}`}
            onClick={startRecording}
            disabled={backendOnline === false}
            aria-label="Start recording"
            id="btn-start-recording"
          >
            🎤 Start Recording
          </button>
        ) : isRecording ? (
          <>
            <button
              className={`${styles.controlBtn} ${styles.btnPause}`}
              onClick={pauseRecording}
              aria-label="Pause recording"
              id="btn-pause-recording"
            >
              ⏸ Pause
            </button>
            <button
              className={`${styles.controlBtn} ${styles.btnStop}`}
              onClick={stopRecording}
              aria-label="Stop recording"
              id="btn-stop-recording"
            >
              ⏹ Stop
            </button>
          </>
        ) : isPaused ? (
          <>
            <button
              className={`${styles.controlBtn} ${styles.btnResume}`}
              onClick={resumeRecording}
              aria-label="Resume recording"
              id="btn-resume-recording"
            >
              ▶ Resume
            </button>
            <button
              className={`${styles.controlBtn} ${styles.btnStop}`}
              onClick={stopRecording}
              aria-label="Stop recording"
              id="btn-stop-recording"
            >
              ⏹ Stop
            </button>
          </>
        ) : null}

        {/* Clear button — always available if there's text */}
        {hasText && isIdle && (
          <button
            className={`${styles.controlBtn} ${styles.btnClear}`}
            onClick={clearTranscript}
            aria-label="Clear transcript"
            id="btn-clear-transcript"
          >
            ✕ Clear
          </button>
        )}

        {/* Audio level meter */}
        {(isRecording) && (
          <div className={styles.levelMeter} aria-label="Audio level" aria-hidden="true">
            <div
              className={`${styles.levelBar} ${audioLevel > 0.3 ? styles.levelBarActive : ''}`}
              style={{ width: `${Math.max(2, audioLevel * 100)}%` }}
            />
          </div>
        )}

        {/* Spacer */}
        <div className={styles.controlsSpacer} />

        {/* Word count */}
        <span className={styles.wordCount} aria-label={`${wordCount} words`}>
          {wordCount} word{wordCount !== 1 ? 's' : ''}
        </span>

        {/* Backend status dot */}
        <span
          className={styles.backendStatus}
          title={backendOnline ? 'STT Service Online' : 'STT Service Offline'}
          aria-label={backendOnline ? 'Speech service online' : 'Speech service offline'}
        >
          <span className={`${styles.backendDot} ${backendOnline ? styles.backendOnline : styles.backendOffline}`} />
          STT
        </span>
      </div>

      {/* ── Transcript display ── */}
      <div
        ref={transcriptAreaRef}
        className={`${styles.transcriptArea} ${isRecording ? styles.transcriptRecording : ''} ${isPaused ? styles.transcriptPaused : ''}`}
        role="textbox"
        aria-readonly="true"
        aria-label="Dictated answer text"
        aria-multiline="true"
        tabIndex={0}
      >
        {hasText ? (
          renderTranscriptContent(finalText, partialText, styles.finalText, styles.partialText)
        ) : (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>🎤</span>
            <span className={styles.emptyText}>
              {backendOnline === false
                ? 'STT service is not available. Please ensure the STT service is running.'
                : 'Click "Start Recording" to begin dictating your answer.'}
            </span>
          </div>
        )}
      </div>

      {/* Processing indicator */}
      {isProcessing && (
        <div
          className={styles.statusPill + ' ' + styles.statusProcessing + ' ' + styles.processingIndicator}
          role="status"
          aria-live="polite"
        >
          <span className={styles.statusDot} />
          Verifying transcript with Whisper…
        </div>
      )}
    </div>
  );
});

export default DictationPanel;
