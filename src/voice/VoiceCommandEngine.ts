/**
 * VoiceCommandEngine.ts — Voice Command Processing Engine
 *
 * Manages a dedicated STT session for voice command recognition.
 * Runs independently from DictationPanel's STT session — it has its own
 * microphone capture pipeline and STT session for command detection.
 *
 * In Command Mode:
 *   - Listens for voice commands via a command-only STT session
 *   - Transcript events are matched against the command registry
 *   - Matched commands trigger callbacks
 *   - Non-command speech is ignored
 *
 * In Dictation Mode:
 *   - The command engine's STT session continues listening for exit commands
 *     ("stop recording", "pause recording") ONLY
 *   - DictationPanel handles the actual answer transcription separately
 *   - Commands are NOT inserted into the answer transcript
 *
 * Architecture:
 *   This engine is instantiated once per exam session and manages its own
 *   audio capture lifecycle. It does NOT share the DictationPanel's microphone
 *   or STT session — they are independent pipelines to the same Python service.
 *
 * The engine uses a separate STT session with the same Vosk pipeline to detect
 * commands. In dictation mode, only stop/pause commands are matched; all other
 * transcript text from the command session is discarded.
 */

import type {
  VoiceMode,
  VoiceCommandId,
  VoiceCommandEvent,
  STTTranscriptEvent,
} from '../types/fairscribe';
import { matchCommand, textContainsCommand, extractQuestionNumber, extractSectionNumber } from './commandMatcher';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target sample rate for STT service. */
const TARGET_SAMPLE_RATE = 16000;

/** Debounce time between command executions (ms) to prevent double-triggers. */
const COMMAND_DEBOUNCE_MS = 1500;

/** Minimum confidence to accept a command match. */
const MIN_CONFIDENCE = 0.70;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VoiceEngineCallbacks {
  onCommandDetected: (event: VoiceCommandEvent) => void;
  onModeChange: (mode: VoiceMode) => void;
  onError: (error: string) => void;
  onCommandSessionTranscript: (text: string, isFinal: boolean) => void;
}

// ---------------------------------------------------------------------------
// Audio Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// VoiceCommandEngine Class
// ---------------------------------------------------------------------------

export class VoiceCommandEngine {
  private mode: VoiceMode = 'command_idle';
  private callbacks: VoiceEngineCallbacks;

  // Audio capture state
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processorNode: ScriptProcessorNode | AudioWorkletNode | null = null;

  // STT session state
  private sessionId: string | null = null;
  private unsubTranscript: (() => void) | null = null;

  // Debounce
  private lastCommandTime = 0;
  private lastCommandId: VoiceCommandId | null = null;

  // Exam context (for creating STT sessions)
  private studentId = '';
  private examId = '';
  private questionId = '';

  // Cleanup flag
  private destroyed = false;

  constructor(callbacks: VoiceEngineCallbacks) {
    this.callbacks = callbacks;
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Get the current voice mode. */
  getMode(): VoiceMode {
    return this.mode;
  }

  /** Set exam context for STT session creation. */
  setExamContext(studentId: string, examId: string, questionId: string): void {
    this.studentId = studentId;
    this.examId = examId;
    this.questionId = questionId;
  }

  /** Update the current question ID (for session tracking). */
  updateQuestionId(questionId: string): void {
    this.questionId = questionId;
  }

  /**
   * Start the voice command engine in Command Mode.
   * Opens a microphone and STT session dedicated to command recognition.
   */
  async startCommandMode(): Promise<void> {
    if (this.destroyed) return;
    if (this.mode !== 'command_idle' && this.mode !== 'command_listening') {
      return;
    }

    try {
      await this.startMicCapture();
      this.setMode('command_listening');
    } catch (err: any) {
      this.callbacks.onError(
        err.name === 'NotAllowedError'
          ? 'Microphone access denied. Voice commands require microphone permission.'
          : err.name === 'NotFoundError'
          ? 'No microphone found. Please connect a microphone for voice commands.'
          : `Voice command engine error: ${err.message}`
      );
    }
  }

  /**
   * Transition to Dictation Mode.
   * The command engine's STT session stays active but only matches
   * stop/pause commands. DictationPanel handles answer transcription.
   */
  enterDictationMode(): void {
    this.setMode('dictation_recording');
  }

  /**
   * Transition to Dictation Paused mode.
   */
  enterDictationPaused(): void {
    this.setMode('dictation_paused');
  }

  /**
   * Return to Command Mode after dictation ends.
   */
  returnToCommandMode(): void {
    this.setMode('command_listening');
  }

  /**
   * Enter Processing mode (Whisper verification in progress).
   */
  enterProcessingMode(): void {
    this.setMode('processing');
  }

  /**
   * Enter the submission confirmation state.
   * Only "confirm submit" and "cancel" commands are active.
   */
  enterConfirmSubmitMode(): void {
    this.setMode('confirming_submit');
  }

  /**
   * Mark the exam as submitted. Stops the engine.
   */
  async markSubmitted(): Promise<void> {
    this.setMode('submitted');
    await this.stopMicCapture();
  }

  /**
   * Fully stop and destroy the engine.
   * Called on component unmount / exam end.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.stopMicCapture();
  }

  // ─── Private: Mode Management ────────────────────────────────────────

  private setMode(mode: VoiceMode): void {
    if (this.mode === mode) return;
    const prev = this.mode;
    this.mode = mode;
    console.log(`[VoiceEngine] Mode: ${prev} → ${mode}`);
    this.callbacks.onModeChange(mode);
  }

  // ─── Private: Microphone Capture ─────────────────────────────────────

  private async startMicCapture(): Promise<void> {
    if (this.mediaStream) return; // Already capturing

    // Request microphone with native sample rate (no forced 16kHz)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.mediaStream = stream;

    // Create STT session for command recognition
    try {
      const { sessionId } = await window.fairscribe.stt.startSession({
        studentId: this.studentId,
        examId: this.examId,
        questionId: `cmd-${this.questionId}`,
        language: 'en',
      });
      this.sessionId = sessionId;
    } catch (err: any) {
      console.error('[VoiceEngine] Failed to create STT session:', err);
      this.stopMicCapture();
      throw new Error('STT service unavailable for voice commands');
    }

    // Subscribe to transcript events from the command session
    if (this.unsubTranscript) this.unsubTranscript();
    this.unsubTranscript = window.fairscribe.stt.onTranscript(
      this.handleTranscriptEvent.bind(this)
    );

    // Set up AudioContext + processor
    const audioCtx = new AudioContext();
    this.audioContext = audioCtx;
    const nativeSampleRate = audioCtx.sampleRate;

    const source = audioCtx.createMediaStreamSource(stream);

    try {
      await audioCtx.audioWorklet.addModule('/pcm-processor.js');
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor');
      this.processorNode = workletNode;

      workletNode.port.onmessage = (e: MessageEvent) => {
        if (e.data?.type === 'audio' && e.data.samples && this.sessionId) {
          const pcmBuffer = downsampleAndConvert(e.data.samples, nativeSampleRate);
          window.fairscribe.stt.sendAudio(this.sessionId, pcmBuffer);
        }
      };

      source.connect(workletNode);
    } catch {
      // Fallback: ScriptProcessorNode
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      this.processorNode = processor;

      processor.onaudioprocess = (e) => {
        if (this.sessionId) {
          const pcmBuffer = downsampleAndConvert(
            e.inputBuffer.getChannelData(0),
            nativeSampleRate
          );
          window.fairscribe.stt.sendAudio(this.sessionId, pcmBuffer);
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
    }

    console.log('[VoiceEngine] Mic capture started, session:', this.sessionId?.slice(0, 8));
  }

  private async stopMicCapture(): Promise<void> {
    // Unsubscribe from transcript events
    if (this.unsubTranscript) {
      this.unsubTranscript();
      this.unsubTranscript = null;
    }

    // Stop audio processor
    if (this.processorNode) {
      this.processorNode.disconnect();
      if ('onaudioprocess' in this.processorNode) {
        (this.processorNode as ScriptProcessorNode).onaudioprocess = null;
      }
      this.processorNode = null;
    }

    // Close AudioContext
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    // Stop media tracks
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    // Clean up STT session
    if (this.sessionId) {
      try {
        await window.fairscribe.stt.stopRecording(this.sessionId).catch(() => {});
        await window.fairscribe.stt.deleteSession(this.sessionId).catch(() => {});
      } catch {
        // Best effort cleanup
      }
      this.sessionId = null;
    }

    console.log('[VoiceEngine] Mic capture stopped');
  }

  // ─── Private: Transcript Processing ──────────────────────────────────

  private handleTranscriptEvent(event: STTTranscriptEvent): void {
    if (this.destroyed) return;
    if (event.sessionId !== this.sessionId) return;

    // Forward transcript to callbacks for debug/display
    if (event.type === 'final' || event.type === 'partial') {
      this.callbacks.onCommandSessionTranscript(
        event.text,
        event.type === 'final'
      );
    }

    // Only process final transcript events for command matching
    if (event.type !== 'final' || !event.text.trim()) return;

    this.processTranscriptForCommand(event.text, event.timestampMs);
  }

  private processTranscriptForCommand(text: string, timestampMs: number): void {
    // ── Check for parametric "go to question N" command first ──
    const qNum = extractQuestionNumber(text);
    if (qNum !== null && this.mode === 'command_listening') {
      // Debounce
      const now = Date.now();
      if (
        'goto_question' === this.lastCommandId &&
        now - this.lastCommandTime < COMMAND_DEBOUNCE_MS
      ) {
        return;
      }
      this.lastCommandTime = now;
      this.lastCommandId = 'goto_question';

      const event: VoiceCommandEvent = {
        commandId: 'goto_question',
        rawText: text,
        confidence: 1.0,
        timestampMs,
        params: { questionNumber: qNum },
      };

      console.log(
        `[VoiceEngine] Parametric command: "goto_question" (question: ${qNum}, text: "${text}")`
      );

      this.callbacks.onCommandDetected(event);
      return;
    }

    // ── Check for parametric "go to section N" command ──
    const sNum = extractSectionNumber(text);
    if (sNum !== null && this.mode === 'command_listening') {
      const now = Date.now();
      if (
        'goto_section' === this.lastCommandId &&
        now - this.lastCommandTime < COMMAND_DEBOUNCE_MS
      ) {
        return;
      }
      this.lastCommandTime = now;
      this.lastCommandId = 'goto_section';

      const event: VoiceCommandEvent = {
        commandId: 'goto_section',
        rawText: text,
        confidence: 1.0,
        timestampMs,
        params: { sectionNumber: sNum },
      };

      console.log(
        `[VoiceEngine] Parametric command: "goto_section" (section: ${sNum}, text: "${text}")`
      );

      this.callbacks.onCommandDetected(event);
      return;
    }
    const match = matchCommand(text, this.mode);
    if (!match) return;
    if (match.confidence < MIN_CONFIDENCE) return;

    // Debounce — prevent the same command from firing twice quickly
    const now = Date.now();
    if (
      match.commandId === this.lastCommandId &&
      now - this.lastCommandTime < COMMAND_DEBOUNCE_MS
    ) {
      return;
    }

    this.lastCommandTime = now;
    this.lastCommandId = match.commandId;

    const event: VoiceCommandEvent = {
      commandId: match.commandId,
      rawText: text,
      confidence: match.confidence,
      timestampMs,
    };

    console.log(
      `[VoiceEngine] Command matched: "${match.commandId}" (confidence: ${match.confidence.toFixed(2)}, text: "${text}")`
    );

    this.callbacks.onCommandDetected(event);
  }
}
