// sql.js uses `export =` (CommonJS-style). With esModuleInterop enabled,
// ts-node resolves this correctly as a default import.
import initSqlJs = require('sql.js');
import type { Database, BindParams, SqlValue } from 'sql.js';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Student {
  studentId: string;
  name: string;
  examId: string;
  disabilityCategory: string | null;
  accommodationProfile: string | null;
  deviceAssigned: string | null;
  accessCode: string;
}

export interface Exam {
  examId: string;
  examTitle: string;
  duration: number;
  languageConfig: string;
  questionPaperHash: string | null;
  sessionKey: string | null;
}

export interface AuditLogEntry {
  id: number;
  eventType: string;
  timestamp: string;
  cryptographicChecksum: string;
  deviceState: string | null;
  invigOverride: number;
}

// ---------------------------------------------------------------------------
// Inline schema
// Inlined rather than read from schema.sql at runtime to avoid path-resolution
// issues when compiled TypeScript runs from dist-electron/.
// The authoritative documentation is still electron/db/schema.sql.
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS Student (
  studentId          TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  examId             TEXT NOT NULL,
  disabilityCategory TEXT,
  accommodationProfile TEXT,
  deviceAssigned     TEXT,
  accessCode         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Exam (
  examId           TEXT PRIMARY KEY,
  examTitle        TEXT NOT NULL,
  duration         INTEGER NOT NULL,
  languageConfig   TEXT NOT NULL,
  questionPaperHash TEXT,
  sessionKey       TEXT
);

CREATE TABLE IF NOT EXISTS AuditLog (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  eventType              TEXT NOT NULL,
  timestamp              TEXT NOT NULL,
  cryptographicChecksum  TEXT NOT NULL,
  deviceState            TEXT,
  invigOverride          INTEGER DEFAULT 0
);
`;

// ---------------------------------------------------------------------------
// DB singleton
// ---------------------------------------------------------------------------

let _db: Database | null = null;
let _dbPath: string = '';

/**
 * Initialises the sql.js WASM engine, opens (or creates) the database file,
 * and applies the schema. Must be awaited once in app.whenReady() before any
 * IPC handler calls getDb().
 *
 * sql.js keeps the database entirely in memory and flushes to disk via
 * persistDb() after every write. This is correct behaviour for a single-user
 * exam session where the dataset is small (one student, one exam).
 *
 * WHY sql.js instead of better-sqlite3?
 * better-sqlite3 is a native C++ addon that must be compiled against
 * Electron's bundled Node ABI. That requires Visual Studio Build Tools
 * (Windows) or Xcode Command Line Tools (macOS). sql.js ships a pre-compiled
 * WebAssembly binary — no native toolchain needed on any platform.
 * Phase 5 (SQLCipher encryption) is the natural point to migrate if needed.
 */
export async function initDb(): Promise<void> {
  // Resolve the sql-wasm.wasm file from node_modules.
  // process.cwd() is the project root both in `npm run dev` (Electron spawned
  // from the project directory) and in production (electron . from project dir).
  const wasmDir = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist');

  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(wasmDir, file),
  });

  // In dev mode, use the project root (where `npm run seed` writes the DB).
  // In production, use Electron's userData directory.
  const isDev = process.env.NODE_ENV === 'development';
  const dbDir = isDev ? process.cwd() : app.getPath('userData');
  _dbPath = path.join(dbDir, 'fairscribe.db');

  if (fs.existsSync(_dbPath)) {
    const fileBuffer = fs.readFileSync(_dbPath);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  // Apply schema (idempotent — CREATE TABLE IF NOT EXISTS)
  _db.run(SCHEMA_SQL);
  persistDb();
}

/**
 * Returns the open Database instance. Throws if initDb() has not been called.
 */
export function getDb(): Database {
  if (!_db) {
    throw new Error('Database not initialised — call initDb() before using getDb().');
  }
  return _db;
}

/**
 * Flushes the in-memory database to disk. Called after every write operation.
 */
function persistDb(): void {
  if (!_db || !_dbPath) return;
  const data = _db.export();
  const dir = path.dirname(_dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_dbPath, Buffer.from(data));
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Execute a SELECT and return all rows as typed objects. */
function queryAll<T>(sql: string, params: SqlValue[] = []): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as unknown as T);
  }
  stmt.free();
  return rows;
}

/** Execute a SELECT and return the first row, or null. */
function queryOne<T>(sql: string, params: SqlValue[] = []): T | null {
  const rows = queryAll<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/** Execute an INSERT / UPDATE / DELETE and flush to disk. */
function runQuery(sql: string, params: SqlValue[] = []): void {
  getDb().run(sql, params);
  persistDb();
}

// ---------------------------------------------------------------------------
// Student queries
// ---------------------------------------------------------------------------

/**
 * Looks up a student by studentId and compares the provided accessCode.
 *
 * PROTOTYPE NOTE: accessCode compared in plaintext. In production,
 * use a salted hash (e.g. Argon2 / bcrypt) + constant-time comparison.
 */
export function getStudentByCredentials(
  studentId: string,
  accessCode: string
): Student | null {
  const row = queryOne<Student>(
    'SELECT * FROM Student WHERE studentId = ?',
    [studentId]
  );
  if (!row || row.accessCode !== accessCode) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Exam queries
// ---------------------------------------------------------------------------

export function getExam(examId: string): Exam | null {
  return queryOne<Exam>('SELECT * FROM Exam WHERE examId = ?', [examId]);
}

export function updateExamHash(examId: string, hash: string): void {
  runQuery('UPDATE Exam SET questionPaperHash = ? WHERE examId = ?', [hash, examId]);
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Inserts a new AuditLog entry with a SHA-256 checksum chained from the
 * previous entry (or "GENESIS" for the first entry).
 *
 * Chain formula:  SHA-256( previousChecksum + JSON.stringify(eventPayload) )
 *
 * Any retroactive edit to a past entry breaks the chain and is detectable
 * via verifyAuditChain().
 */
export function insertAuditLog(
  eventType: string,
  deviceState?: Record<string, unknown>,
  invigOverride = false
): void {
  const timestamp = new Date().toISOString();

  const lastEntry = queryOne<{ cryptographicChecksum: string }>(
    'SELECT cryptographicChecksum FROM AuditLog ORDER BY id DESC LIMIT 1'
  );
  const previousChecksum = lastEntry?.cryptographicChecksum ?? 'GENESIS';

  const eventPayload = JSON.stringify({
    eventType,
    timestamp,
    deviceState: deviceState ?? null,
  });
  const newChecksum = crypto
    .createHash('sha256')
    .update(previousChecksum + eventPayload)
    .digest('hex');

  runQuery(
    `INSERT INTO AuditLog (eventType, timestamp, cryptographicChecksum, deviceState, invigOverride)
     VALUES (?, ?, ?, ?, ?)`,
    [
      eventType,
      timestamp,
      newChecksum,
      deviceState ? JSON.stringify(deviceState) : null,
      invigOverride ? 1 : 0,
    ]
  );
}

// ---------------------------------------------------------------------------
// Audit chain verification
// ---------------------------------------------------------------------------

/**
 * Walks every AuditLog row in order and recomputes each checksum from scratch.
 * Returns { valid: true } if the chain is intact, or { valid: false, brokenAt: id }
 * identifying the first broken link.
 *
 * Exposed via IPC as 'audit:verify'. Runnable standalone via `npm run verify-audit`.
 */
export function verifyAuditChain(): { valid: boolean; brokenAt?: number } {
  const rows = queryAll<AuditLogEntry>('SELECT * FROM AuditLog ORDER BY id ASC');
  let previousChecksum = 'GENESIS';

  for (const row of rows) {
    const eventPayload = JSON.stringify({
      eventType: row.eventType,
      timestamp: row.timestamp,
      deviceState: row.deviceState ? JSON.parse(row.deviceState) : null,
    });

    const expected = crypto
      .createHash('sha256')
      .update(previousChecksum + eventPayload)
      .digest('hex');

    if (expected !== row.cryptographicChecksum) {
      return { valid: false, brokenAt: row.id };
    }
    previousChecksum = row.cryptographicChecksum;
  }

  return { valid: true };
}
