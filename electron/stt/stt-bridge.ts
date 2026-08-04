/**
 * stt-bridge.ts — Electron ↔ Python STT Service Bridge
 *
 * Encapsulates all HTTP + WebSocket communication between the Electron
 * main process and the Python STT service running on localhost:5400.
 *
 * This module is used exclusively by main.ts's IPC handlers. The renderer
 * never communicates with the Python service directly — all traffic flows
 * through preload.ts → IPC → this bridge → HTTP/WS.
 *
 * No new npm dependencies — uses Node.js built-in `http` module and the
 * `ws` package bundled with Electron.
 */

import * as http from 'http';
import { WebSocket } from 'ws';
import { BrowserWindow } from 'electron';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STT_HOST = '127.0.0.1';
const STT_PORT = 5400;
const STT_BASE = `http://${STT_HOST}:${STT_PORT}`;
const WS_BASE = `ws://${STT_HOST}:${STT_PORT}`;

// ---------------------------------------------------------------------------
// Types (matching the Python Pydantic models, camelCased for JS)
// ---------------------------------------------------------------------------

interface STTSessionInfo {
  session_id: string;
  status: string;
  student_id: string;
  exam_id: string;
  question_id: string;
  language: string;
  created_at: string;
  updated_at: string;
  audio_duration_seconds: number;
  vosk_transcript: string;
}

interface STTVerificationResult {
  session_id: string;
  vosk_transcript: string;
  whisper_transcript: string;
  final_transcript: string;
  whisper_available: boolean;
  whisper_confidence: number;
  audio_duration_seconds: number;
  processing_time_seconds: number;
  status: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request to the Python STT service.
 * Uses Node.js built-in http module — no axios/fetch dependency needed.
 */
function request(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      hostname: STT_HOST,
      port: STT_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: 30000, // 30s timeout (Whisper verification can take time)
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode ?? 0, data: parsed });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: data });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('STT service request timed out'));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// STT Bridge
// ---------------------------------------------------------------------------

/** Active WebSocket connections keyed by sessionId. */
const activeStreams = new Map<string, WebSocket>();

/**
 * Check if the Python STT service is running and engines are loaded.
 */
export async function checkHealth(): Promise<any> {
  const { data } = await request('GET', '/api/health');
  return data;
}

/**
 * Create a new STT session on the Python service.
 */
export async function createSession(config: {
  studentId: string;
  examId: string;
  questionId: string;
  language?: string;
}): Promise<STTSessionInfo> {
  const { status, data } = await request('POST', '/api/sessions', {
    student_id: config.studentId,
    exam_id: config.examId,
    question_id: config.questionId,
    language: config.language ?? 'en',
  });

  if (status !== 201) {
    throw new Error(`Failed to create session: ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Open a WebSocket stream to the Python STT service for real-time
 * audio streaming and transcript reception.
 *
 * Transcript events are forwarded to the renderer via
 * mainWindow.webContents.send('stt:transcript', event).
 */
export function openStream(
  sessionId: string,
  mainWindow: BrowserWindow | null
): void {
  // Close existing stream for this session if any
  closeStream(sessionId);

  const wsUrl = `${WS_BASE}/api/sessions/${sessionId}/stream`;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`[STT Bridge] WebSocket connected: session=${sessionId.slice(0, 8)}`);
  });

  ws.on('message', (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Forward to renderer as a camelCased transcript event
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stt:transcript', {
          sessionId: msg.session_id ?? sessionId,
          type: msg.type ?? 'partial',
          text: msg.text ?? '',
          confidence: msg.confidence ?? 0,
          isSpeech: msg.is_speech ?? true,
          timestampMs: msg.timestamp_ms ?? 0,
        });
      }
    } catch (err) {
      console.error('[STT Bridge] Failed to parse WS message:', err);
    }
  });

  ws.on('error', (err) => {
    console.error(`[STT Bridge] WebSocket error (session=${sessionId.slice(0, 8)}):`, err.message);
  });

  ws.on('close', (code, reason) => {
    console.log(
      `[STT Bridge] WebSocket closed: session=${sessionId.slice(0, 8)}, code=${code}`
    );
    activeStreams.delete(sessionId);
  });

  activeStreams.set(sessionId, ws);
}

/**
 * Send raw PCM audio bytes to the Python STT service via WebSocket.
 */
export function sendAudio(sessionId: string, chunk: Buffer): boolean {
  const ws = activeStreams.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  ws.send(chunk);
  return true;
}

/**
 * Close the WebSocket stream for a session.
 */
export function closeStream(sessionId: string): void {
  const ws = activeStreams.get(sessionId);
  if (ws) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    activeStreams.delete(sessionId);
  }
}

/**
 * Stop recording: close WebSocket, then call POST /api/sessions/{id}/stop
 * to trigger Whisper verification.
 */
export async function stopRecording(
  sessionId: string,
  runWhisper = true
): Promise<STTVerificationResult> {
  // Close the audio stream first
  closeStream(sessionId);

  const { status, data } = await request(
    'POST',
    `/api/sessions/${sessionId}/stop`,
    { run_whisper_verification: runWhisper }
  );

  if (status !== 200) {
    throw new Error(`Failed to stop recording: ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Delete an STT session and free resources.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  closeStream(sessionId);

  const { status } = await request('DELETE', `/api/sessions/${sessionId}`);
  if (status !== 200 && status !== 204) {
    console.warn(`[STT Bridge] Delete session returned status ${status}`);
  }
}

/**
 * Clean up all active streams. Called on app shutdown.
 */
export function closeAll(): void {
  for (const [sessionId] of activeStreams) {
    closeStream(sessionId);
  }
}
