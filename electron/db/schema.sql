-- FairScribe Database Schema
-- Phase 1–2: Authentication + Question Paper Rendering
--
-- All tables use CREATE TABLE IF NOT EXISTS so this file can be
-- applied idempotently (re-run safely on existing databases).
-- Migrations are applied by electron/db/db.ts at app startup.

-- ============================================================
-- Student
-- Identity and authentication info for exam candidates.
-- ============================================================
CREATE TABLE IF NOT EXISTS Student (
  studentId          TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  examId             TEXT NOT NULL,
  disabilityCategory TEXT,               -- e.g. "motor_impairment", "visual_impairment"
  accommodationProfile TEXT,             -- JSON blob describing specific accommodations
  deviceAssigned     TEXT,               -- MAC address or device serial of the assigned terminal
  accessCode         TEXT NOT NULL       -- PROTOTYPE ONLY: plaintext access code.
                                         -- KNOWN LIMITATION: In production this must be a
                                         -- salted hash (e.g. bcrypt). See README §Known Limitations.
);

-- ============================================================
-- Exam
-- Metadata for an exam session.
-- ============================================================
CREATE TABLE IF NOT EXISTS Exam (
  examId           TEXT PRIMARY KEY,
  examTitle        TEXT NOT NULL,
  duration         INTEGER NOT NULL,    -- seconds; e.g. 7200 = 2 hours
  languageConfig   TEXT NOT NULL,       -- BCP-47 tag, e.g. "en-IN"
  questionPaperHash TEXT,               -- SHA-256 hex of sample-exam.json raw bytes,
                                        -- computed at load time and stored for integrity verification
  sessionKey       TEXT                 -- placeholder for Phase 5 encryption key exchange
);

-- ============================================================
-- AuditLog
-- Hash-chained, append-only event log for the entire exam session.
--
-- Each entry's cryptographicChecksum is:
--   SHA-256( previousChecksum + JSON.stringify(event) )
-- where previousChecksum is "GENESIS" for the first entry.
--
-- This means any retroactive edit to a past entry breaks the chain
-- and is detectable via verifyAuditChain() in electron/db/db.ts.
-- ============================================================
CREATE TABLE IF NOT EXISTS AuditLog (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  eventType              TEXT NOT NULL,          -- e.g. "login_success", "question_navigated"
  timestamp              TEXT NOT NULL,          -- ISO 8601, e.g. "2024-01-15T09:30:00.000Z"
  cryptographicChecksum  TEXT NOT NULL,          -- SHA-256 hash chained from previous entry
  deviceState            TEXT,                   -- optional JSON blob (e.g. battery %, question index)
  invigOverride          INTEGER DEFAULT 0       -- 1 if this event was triggered by invigilator action
);

-- ============================================================
-- TODO (Phase 3): Answer table
--
-- Will store per-question answer state for each candidate.
-- Planned schema (do not create yet — slot in without rework):
--
-- CREATE TABLE IF NOT EXISTS Answer (
--   answerId          TEXT PRIMARY KEY,       -- UUID
--   studentId         TEXT NOT NULL REFERENCES Student(studentId),
--   examId            TEXT NOT NULL REFERENCES Exam(examId),
--   questionId        TEXT NOT NULL,
--   currentText       TEXT NOT NULL DEFAULT '',
--   dictationSegments TEXT NOT NULL DEFAULT '[]',  -- JSON array of {segmentId, voskRaw, whisperVerification, timestamp}
--   editHistory       TEXT NOT NULL DEFAULT '[]',  -- JSON array of {action, payload, timestamp, checksum}
--   lastSaved         TEXT,                        -- ISO 8601, updated on every autosave
--   UNIQUE(studentId, questionId)
-- );
-- ============================================================
