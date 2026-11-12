/**
 * Sync state persistence — thin adapter over the memory backend's
 * `mem_sync_state` table. Historically this lived in `.one/sync/state/
 * <platform>/<model>.json`; the unified memory branch moves it into the
 * database so the whole sync subsystem has a single source of truth.
 *
 * Legacy files (both the newer per-model layout and the older single-
 * file `sync_state.json`) are imported only by `one mem migrate`, never
 * on their own: a cloned repo can ship them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getBackend } from '../runtime.js';
import type { SyncStateRow } from '../types.js';
import type { SyncState, ModelSyncState } from './types.js';

const SYNC_DIR = path.join('.one', 'sync');
const STATE_DIR = path.join(SYNC_DIR, 'state');
const LEGACY_SINGLE_FILE = path.join(SYNC_DIR, 'sync_state.json');

// ── Row ↔ ModelSyncState conversion ────────────────────────────────────────
//
// The backend row uses snake_case + JSONB; the sync module's in-memory
// shape is camelCase with `unknown` for cursor payloads. Keep the two
// shapes local so the rest of the codebase can keep using ModelSyncState
// without re-flowing types everywhere.

function rowToState(row: SyncStateRow): ModelSyncState {
  return {
    lastSync: row.last_sync_at ?? null,
    lastCursor: row.last_cursor ?? null,
    totalRecords: row.total_records,
    pagesProcessed: row.pages_processed,
    since: row.since ?? null,
    status: row.status,
  };
}

function stateToRow(platform: string, model: string, state: ModelSyncState, lastError?: string | null): SyncStateRow {
  return {
    platform,
    model,
    last_sync_at: state.lastSync ?? null,
    last_cursor: state.lastCursor ?? null,
    since: state.since ?? null,
    total_records: state.totalRecords,
    pages_processed: state.pagesProcessed,
    status: state.status,
    last_error: lastError ?? null,
  };
}

// ── Legacy file import (explicit, via `one mem migrate`) ────────────────────
//
// These files live inside the project folder, so a cloned repo can ship
// them. They used to be imported on the first sync-state read of every
// command; now only `one mem migrate` imports them, and only when the
// backend has no state yet for that platform/model. They are never
// deleted here: `mem migrate --cleanup` removes them.

export interface LegacySyncStateEntry {
  platform: string;
  model: string;
  state: ModelSyncState;
  file: string;
}

/** Every legacy progress entry on disk, optionally limited to one platform. */
export function listLegacySyncStateEntries(platformFilter?: string): LegacySyncStateEntry[] {
  const out: LegacySyncStateEntry[] = [];

  // Old single-file layout (SyncState map, pre-per-model JSON).
  if (fs.existsSync(LEGACY_SINGLE_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_SINGLE_FILE, 'utf-8')) as SyncState;
      for (const [platform, models] of Object.entries(legacy ?? {})) {
        if (platformFilter && platform !== platformFilter) continue;
        for (const [model, state] of Object.entries(models ?? {})) {
          out.push({ platform, model, state, file: LEGACY_SINGLE_FILE });
        }
      }
    } catch {
      // Unreadable — nothing to import.
    }
  }

  // Per-model files at `.one/sync/state/<platform>/<model>.json`.
  if (fs.existsSync(STATE_DIR)) {
    let platforms: string[] = [];
    try { platforms = fs.readdirSync(STATE_DIR); } catch { /* ignore */ }
    for (const platform of platforms) {
      if (platformFilter && platform !== platformFilter) continue;
      const platformDir = path.join(STATE_DIR, platform);
      let entries: string[];
      try { entries = fs.readdirSync(platformDir); } catch { continue; }
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const file = path.join(platformDir, entry);
        try {
          const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as ModelSyncState;
          out.push({ platform, model: entry.slice(0, -'.json'.length), state, file });
        } catch {
          // Skip unreadable files.
        }
      }
    }
  }
  return out;
}

/** Paths `mem migrate --cleanup` removes for legacy progress files. */
export function legacySyncStatePaths(): string[] {
  return [LEGACY_SINGLE_FILE, STATE_DIR].filter(p => fs.existsSync(p));
}

/**
 * Import legacy progress files into the backend. Never overwrites state the
 * backend already has. With `dryRun`, only counts.
 */
export async function importLegacySyncState(
  opts: { platform?: string; dryRun?: boolean } = {},
): Promise<{ imported: number; skippedExisting: number }> {
  const entries = listLegacySyncStateEntries(opts.platform);
  if (entries.length === 0) return { imported: 0, skippedExisting: 0 };
  const backend = await getBackend();
  let imported = 0;
  let skippedExisting = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const id = `${e.platform}/${e.model}`;
    if (seen.has(id)) { skippedExisting++; continue; }
    seen.add(id);
    if (await backend.getSyncState(e.platform, e.model)) { skippedExisting++; continue; }
    if (!opts.dryRun) await backend.setSyncState(stateToRow(e.platform, e.model, e.state));
    imported++;
  }
  return { imported, skippedExisting };
}

// ── Public API (async; was previously sync file I/O) ───────────────────────

export async function readSyncState(): Promise<SyncState> {
  const backend = await getBackend();
  const rows = await backend.listSyncStates();
  const result: SyncState = {};
  for (const row of rows) {
    if (!result[row.platform]) result[row.platform] = {};
    result[row.platform][row.model] = rowToState(row);
  }
  return result;
}

export async function getModelState(platform: string, model: string): Promise<ModelSyncState | null> {
  const backend = await getBackend();
  const row = await backend.getSyncState(platform, model);
  return row ? rowToState(row) : null;
}

export async function updateModelState(
  platform: string,
  model: string,
  partial: Partial<ModelSyncState>,
): Promise<void> {
  const backend = await getBackend();
  const existing = (await backend.getSyncState(platform, model)) ?? stateToRow(platform, model, {
    lastSync: null,
    lastCursor: null,
    totalRecords: 0,
    pagesProcessed: 0,
    since: null,
    status: 'idle',
  });
  const merged = rowToState(existing);
  const next: ModelSyncState = { ...merged, ...partial };
  await backend.setSyncState(stateToRow(platform, model, next));
}

export async function removeModelState(platform: string, model?: string): Promise<void> {
  const backend = await getBackend();
  await backend.removeSyncState(platform, model);
}
