-- FairScribe Database Schema
-- Phase 1–3 (partial): Authentication + Question Paper Rendering + Answer Status
--
-- All tables use CREATE TABLE IF NOT EXISTS so this file can be
-- applied idempotently (re-run safely on existing databases).
-- Migrations are applied by electron/db/db.ts at app startup.
--
-- NOTE: The authoritative schema for runtime use is the SCHEMA_SQL constant
-- inlined in electron/db/db.ts. This file is kept in sync for documentation
-- purposes only.

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
--
-- Phase 3 adds these new eventType values (no schema change needed):
--   instructions_acknowledged
--   section_changed
--   question_status_changed  (deviceState: { questionId, fromStatus, toStatus })
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
-- Section (Phase 3 — partial)
-- Maps sections from sample-exam.json into the database.
-- Populated at question paper load time.
-- ============================================================
CREATE TABLE IF NOT EXISTS Section (
  sectionId    TEXT PRIMARY KEY,
  examId       TEXT NOT NULL,
  sectionName  TEXT NOT NULL,
  sectionOrder INTEGER NOT NULL,
  FOREIGN KEY (examId) REFERENCES Exam(examId)
);

-- ============================================================
-- Answer (Phase 3 — partial)
-- Tracks per-question answer state for each candidate.
--
-- Initialized with status='not_visited' for all questions when the
-- candidate acknowledges the Instructions screen.
--
-- Status lifecycle:
--   not_visited            → initial state (before candidate opens question)
--   not_answered           → question opened but no answer dictated
--   answered               → candidate clicked "Save & Next" with answer content
--   marked_for_review      → flagged for review, no answer content
--   answered_marked_for_review → flagged for review WITH answer content
--
-- answerText is always '' in Phase 3 (partial). Real dictation text
-- will populate this field when Phase 3 (dictation engine) is implemented.
-- ============================================================
CREATE TABLE IF NOT EXISTS Answer (
  questionId      TEXT NOT NULL,
  studentId       TEXT NOT NULL,
  answerText      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'not_visited',
  visitedAt       TEXT,                            -- ISO 8601, set when first opened
  lastModifiedAt  TEXT,                            -- ISO 8601, updated on every status change
  PRIMARY KEY (questionId, studentId)
);
