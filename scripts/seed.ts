/**
 * seed.ts — FairScribe database seeder (sql.js version)
 *
 * Reads seed-students.json and sample-exam.json and inserts all records
 * into the SQLite database. Idempotent — safe to re-run without duplicates.
 *
 * Uses sql.js (WebAssembly SQLite) — no native build tools required.
 *
 * Usage: npm run seed
 */

import initSqlJs = require('sql.js');
import type { Database, SqlValue } from 'sql.js';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Paths (all relative to project root — npm run seed is run from there)
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WASM_DIR    = path.join(PROJECT_ROOT, 'node_modules', 'sql.js', 'dist');
const DB_PATH     = path.join(PROJECT_ROOT, 'fairscribe.db');
const SCHEMA_PATH = path.join(PROJECT_ROOT, 'electron', 'db', 'schema.sql');
const SEED_PATH   = path.join(PROJECT_ROOT, 'data', 'seed-students.json');
const EXAM_PATH   = path.join(PROJECT_ROOT, 'data', 'sample-exam.json');

// ---------------------------------------------------------------------------
// Inline schema (same content as schema.sql — avoids path issues)
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
// Helpers
// ---------------------------------------------------------------------------

function saveDb(db: Database): void {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function getLastChecksum(db: Database): string {
  const stmt = db.prepare(
    'SELECT cryptographicChecksum FROM AuditLog ORDER BY id DESC LIMIT 1'
  );
  const exists = stmt.step();
  const checksum = exists
    ? (stmt.getAsObject() as { cryptographicChecksum: string }).cryptographicChecksum
    : 'GENESIS';
  stmt.free();
  return checksum;
}

function insertAuditLog(
  db: Database,
  eventType: string,
  deviceState: Record<string, unknown>
): void {
  const timestamp = new Date().toISOString();
  const previousChecksum = getLastChecksum(db);
  const payload = JSON.stringify({ eventType, timestamp, deviceState });
  const checksum = crypto
    .createHash('sha256')
    .update(previousChecksum + payload)
    .digest('hex');

  db.run(
    `INSERT INTO AuditLog (eventType, timestamp, cryptographicChecksum, deviceState, invigOverride)
     VALUES (?, ?, ?, ?, 0)`,
    [eventType, timestamp, checksum, JSON.stringify(deviceState)]
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('FairScribe — Database Seeder\n');

  // Initialise sql.js WASM
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(WASM_DIR, file),
  });

  // Open existing DB or create fresh
  let db: Database;
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    console.log(`Opened existing DB: ${DB_PATH}`);
  } else {
    db = new SQL.Database();
    console.log(`Creating new DB: ${DB_PATH}`);
  }

  // Apply schema
  db.run(SCHEMA_SQL);

  // ── Seed Exam ──────────────────────────────────────────────────────────────

  const examRaw  = fs.readFileSync(EXAM_PATH, 'utf-8');
  const examData = JSON.parse(examRaw);
  const examHash = crypto.createHash('sha256').update(examRaw, 'utf-8').digest('hex');

  // Check if exam already exists
  const examStmt = db.prepare('SELECT examId FROM Exam WHERE examId = ?');
  examStmt.bind([examData.examId]);
  const examExists = examStmt.step();
  examStmt.free();

  if (!examExists) {
    db.run(
      `INSERT INTO Exam (examId, examTitle, duration, languageConfig, questionPaperHash, sessionKey)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [examData.examId, examData.examTitle, examData.duration, examData.languageConfig, examHash]
    );
    console.log(`✓ Exam seeded: ${examData.examId} — "${examData.examTitle}"`);
  } else {
    console.log(`  Exam already exists: ${examData.examId} — skipping`);
  }
  console.log(`  SHA-256: ${examHash}`);

  // ── Seed Students ──────────────────────────────────────────────────────────

  const seedData = JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8'));

  for (const student of seedData.students) {
    const checkStmt = db.prepare('SELECT studentId FROM Student WHERE studentId = ?');
    checkStmt.bind([student.studentId]);
    const studentExists = checkStmt.step();
    checkStmt.free();

    if (!studentExists) {
      db.run(
        `INSERT INTO Student (studentId, name, examId, disabilityCategory, accommodationProfile, deviceAssigned, accessCode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          student.studentId,
          student.name,
          student.examId,
          student.disabilityCategory,
          student.accommodationProfile,
          student.deviceAssigned,
          student.accessCode,
        ]
      );
      console.log(
        `✓ Student seeded: ${student.studentId} — ${student.name} [${student.disabilityCategory}]`
      );
    } else {
      console.log(`  Student already exists: ${student.studentId} — skipping`);
    }
  }

  // ── Genesis AuditLog entry ─────────────────────────────────────────────────

  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM AuditLog');
  countStmt.step();
  const logCount = (countStmt.getAsObject() as { cnt: number }).cnt;
  countStmt.free();

  if (logCount === 0) {
    insertAuditLog(db, 'db_seeded', { seedVersion: '1.0', examId: examData.examId });
    console.log(`✓ Genesis AuditLog entry written`);
  } else {
    console.log(`  AuditLog has ${logCount} entries — skipping genesis entry`);
  }

  // ── Persist ────────────────────────────────────────────────────────────────

  saveDb(db);
  db.close();

  console.log(`\n✅ Seed complete. DB written to: ${DB_PATH}`);
  console.log('\nTest credentials:');
  for (const s of seedData.students) {
    console.log(`  studentId: ${s.studentId.padEnd(16)}  accessCode: ${s.accessCode}`);
  }
}

main().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
