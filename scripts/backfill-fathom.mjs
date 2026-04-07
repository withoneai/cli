#!/usr/bin/env node
/**
 * Backfill Fathom meetings with transcripts and summaries.
 * Fetches each meeting's transcript and summary via the One CLI,
 * then updates the local SQLite database directly.
 *
 * Rate limit: 1 request per second (conservative for Fathom's API).
 * Retries on 429 with exponential backoff.
 */

import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';

const CLI = 'node /Users/moe/projects/one/connection-cli/bin/cli.js';
const DB_PATH = '.one/sync/data/fathom.db';
const CONNECTION_KEY = 'live::fathom::default::abfd8f7e6b4d49658704471139969a8b';
const TRANSCRIPT_ACTION = 'conn_mod_def::GIpBYRQXBLg::i24wKi0TT7mR8qDUpHetnQ';
const SUMMARY_ACTION = 'conn_mod_def::GIpBYFV5Mog::G6aag6ykQ-uD6XCeUUnq7Q';
const DELAY_MS = 1000; // 1 second between requests
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function executeAction(actionId, recordingId) {
  const cmd = `${CLI} --agent actions execute fathom "${actionId}" "${CONNECTION_KEY}" --path-vars '{"RECORDING_ID":"${recordingId}"}'`;
  try {
    const output = execSync(cmd, { timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const parsed = JSON.parse(output.trim());
    if (parsed.error) return { error: parsed.error };
    return parsed.response;
  } catch (err) {
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';
    // Check for rate limit in output
    if (stdout.includes('429') || stderr.includes('429') || stdout.includes('Rate limit')) {
      return { error: '429', rateLimited: true };
    }
    return { error: stderr || err.message };
  }
}

async function fetchWithRetry(actionId, recordingId, label) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = executeAction(actionId, recordingId);
    if (result?.rateLimited) {
      const waitTime = DELAY_MS * Math.pow(2, attempt + 1);
      process.stderr.write(`  Rate limited on ${label}, waiting ${waitTime / 1000}s...\n`);
      await sleep(waitTime);
      continue;
    }
    return result;
  }
  return { error: 'Max retries exceeded' };
}

async function main() {
  const db = new Database(DB_PATH);

  // Get all recording IDs that don't have transcripts yet
  const meetings = db.prepare(`
    SELECT recording_id, title
    FROM meetings
    WHERE transcript IS NULL
    ORDER BY created_at DESC
  `).all();

  console.log(`Found ${meetings.length} meetings without transcripts. Starting backfill...\n`);

  const updateStmt = db.prepare(`
    UPDATE meetings
    SET transcript = ?, default_summary = ?
    WHERE recording_id = ?
  `);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < meetings.length; i++) {
    const { recording_id, title } = meetings[i];
    process.stderr.write(`[${i + 1}/${meetings.length}] ${title}...`);

    // Fetch transcript
    const transcriptResult = await fetchWithRetry(TRANSCRIPT_ACTION, recording_id, 'transcript');
    await sleep(DELAY_MS);

    // Fetch summary
    const summaryResult = await fetchWithRetry(SUMMARY_ACTION, recording_id, 'summary');
    await sleep(DELAY_MS);

    const transcript = transcriptResult?.transcript ? JSON.stringify(transcriptResult.transcript) : null;
    const summary = summaryResult?.summary ? JSON.stringify(summaryResult.summary) : null;

    if (transcript || summary) {
      updateStmt.run(transcript, summary, recording_id);
      success++;
      process.stderr.write(` done (transcript: ${transcript ? 'yes' : 'no'}, summary: ${summary ? 'yes' : 'no'})\n`);
    } else {
      failed++;
      const err = transcriptResult?.error || summaryResult?.error || 'unknown';
      process.stderr.write(` failed (${typeof err === 'string' ? err.substring(0, 80) : 'error'})\n`);
    }
  }

  db.close();

  console.log(`\nBackfill complete: ${success} updated, ${failed} failed, ${meetings.length} total.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
