/**
 * FairScribe — Electron Main Process Configuration
 *
 * PROTOTYPE CONFIGURATION — These values must be replaced with a real
 * institutional mechanism before any live exam deployment.
 */

/**
 * Hardcoded invigilator PIN for prototype/demo purposes only.
 *
 * KNOWN LIMITATION: In a real deployment, invigilator authentication
 * would use a per-session PIN issued by the exam authority, stored
 * securely and never hardcoded. This placeholder exists only to unblock
 * Phase 1 development.
 */
export const INVIGILATOR_PIN = '0000';

/**
 * Dev server URL loaded by Electron in development.
 * In production, Electron loads dist/index.html instead.
 *
 * NOTE: This port must match vite.config.ts server.port.
 * vite.config.ts uses strictPort: true, so Vite will fail rather than
 * silently bump to 5174 — which would break this URL without warning.
 */
export const VITE_DEV_SERVER_URL = 'http://localhost:5173';
