/**
 * verify-audit.ts — FairScribe audit chain verifier (sql.js version)
 *
 * Opens the dev database read-only (sql.js loads from file buffer),
 * recomputes every cryptographic checksum in order, and reports any
 * broken links — which indicate retroactive tampering.
 *
 * Usage: npm run verify-audit
 */

import initSqlJs = require('sql.js');
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WASM_DIR     = path.join(PROJECT_ROOT, 'node_modules', 'sql.js', 'dist');
const DB_PATH      = path.join(PROJECT_ROOT, 'fairscribe.db');

interface AuditLogRow {
  id: number;
  eventType: string;
  timestamp: string;
  cryptographicChecksum: string;
  deviceState: string | null;
  invigOverride: number;
}

async function main(): Promise<void> {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ Could not open database at: ${DB_PATH}`);
    console.error('   Run `npm run seed` first to create and seed the database.');
    process.exit(1);
  }

  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(WASM_DIR, file),
  });

  // sql.js loads the entire file into memory — effectively read-only since
  // we do not call db.export() / write back to disk.
  const buf = fs.readFileSync(DB_PATH);
  const db  = new SQL.Database(buf);

  // Fetch all rows
  const stmt = db.prepare('SELECT * FROM AuditLog ORDER BY id ASC');
  const rows: AuditLogRow[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as unknown as AuditLogRow);
  }
  stmt.free();
  db.close();

  if (rows.length === 0) {
    console.log('⚠️  AuditLog is empty — nothing to verify.');
    process.exit(0);
  }

  console.log(`Verifying audit chain (${rows.length} entries)...\n`);

  let previousChecksum = 'GENESIS';
  let brokenAt: number | null = null;

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
      brokenAt = row.id;
      console.error(`❌ BROKEN at entry ID ${row.id}`);
      console.error(`   Event type: ${row.eventType}`);
      console.error(`   Timestamp:  ${row.timestamp}`);
      console.error(`   Expected:   ${expected}`);
      console.error(`   Got:        ${row.cryptographicChecksum}`);
      break;
    }

    const idPad   = String(row.id).padStart(4, '0');
    const typePad = row.eventType.padEnd(30);
    console.log(`  [${idPad}] ✓ ${typePad} ${row.timestamp}`);
    previousChecksum = row.cryptographicChecksum;
  }

  console.log('');
  if (brokenAt !== null) {
    console.error(`❌ Chain verification FAILED at entry ID ${brokenAt}.`);
    console.error('   This indicates the AuditLog was retroactively modified.');
    process.exit(1);
  } else {
    console.log(`✅ Audit chain VALID — ${rows.length} entries verified.`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('❌ Verification error:', err);
  process.exit(1);
});
