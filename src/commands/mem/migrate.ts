/**
 * `one mem migrate` — import legacy .one/sync/data/*.db files into the
 * unified memory store.
 *
 * Idempotent: uses upsertByKeys keyed by `<platform>/<model>:<row-id>` so
 * re-runs over the same files produce zero new writes. Optional identity
 * dedup (--identity) promotes a profile's `identityKey` into a second,
 * cross-source key so Gmail/Attio/Fathom rows about the same person merge
 * into one record.
 *
 * Does not delete legacy files. Pass --cleanup after verifying the import
 * to remove them.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as output from '../../lib/output.js';
import * as p from '@clack/prompts';
import { getBackend } from '../../lib/memory/runtime.js';
import { upsertRecord } from '../../lib/memory/runtime.js';
import { readProfile } from '../../lib/memory/sync/profile.js';
import { openDatabase, listSyncedPlatforms, listTables, countRecords } from '../../lib/memory/sync/db.js';
import { okJson, requireMemoryInit } from './util.js';
import { getByDotPath } from '../../lib/dot-path.js';

interface MigrateFlags {
  platform?: string;
  dryRun?: boolean;
  cleanup?: boolean;
  yes?: boolean;
}

interface MigrateReport {
  platform: string;
  model: string;
  rowsSeen: number;
  inserted: number;
  updated: number;
  skipped: number;
  /** Rows skipped because the idField path resolved to nothing (missing profile, bad path, nested). */
  skippedUnresolvedId: number;
  /** Rows skipped because the upsert threw (key conflict, schema violation, etc). */
  skippedError: number;
}

export async function memMigrateCommand(flags: MigrateFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();

  const platforms = flags.platform ? [flags.platform] : listSyncedPlatforms();
  if (platforms.length === 0) {
    okJson({ status: 'noop', reason: 'no legacy .one/sync/data/*.db files found' });
    return;
  }

  // Dry-run verb prediction: ask the backend whether a key already exists
  // so the preview matches the real run. Without this, re-running dry-run
  // after a live migrate always reports `inserted: N` on rows that would
  // actually `updated` (the trust-bug Moe flagged in #126).
  const canPredict = backend.capabilities().rawSql && typeof backend.raw === 'function';
  const keyExists = async (keys: string[]): Promise<boolean> => {
    if (!canPredict || keys.length === 0) return false;
    try {
      const res = await backend.raw!(
        `SELECT 1 FROM mem_records WHERE keys && $1::text[] LIMIT 1`,
        [keys],
      );
      return res.rowCount > 0;
    } catch {
      return false;
    }
  };

  const reports: MigrateReport[] = [];
  for (const platform of platforms) {
    const db = await openDatabase(platform);
    try {
      const tables = listTables(db).filter(t => !t.endsWith('_fts'));
      for (const model of tables) {
        const total = countRecords(db, model);
        const rows = db.prepare(`SELECT * FROM "${model}"`).all() as Array<Record<string, unknown>>;
        const report: MigrateReport = {
          platform, model, rowsSeen: total, inserted: 0, updated: 0, skipped: 0,
          skippedUnresolvedId: 0, skippedError: 0,
        };
        const profile = readProfile(platform, model);
        const idField = profile?.idField;
        const identityKey = profile?.identityKey;

        for (const row of rows) {
          // Legacy SQLite flattens first-level fields. Nested objects (e.g.
          // Attio's `{workspace_id, object_id, record_id}`) land as JSON-
          // stringified text in the `id` column. Rehydrate top-level JSON
          // strings so dot-path resolution mirrors `sync run` — otherwise
          // `id.record_id` returns undefined on companies and every row
          // gets silently skipped (Moe's post-migrate repro, 2024/2024
          // skipped on attioCompanies).
          const hydrated = reviveStringifiedJson(row);

          const externalRaw = idField ? getByDotPath(hydrated, idField) : undefined;
          // Hard reject: the same guard sync test/mem-writer apply — an
          // object id would String()-stringify to `[object Object]` and
          // collapse every row onto one key. Better to skip visibly than
          // to silently dedup the entire table.
          if (
            !idField ||
            externalRaw === undefined ||
            externalRaw === null ||
            externalRaw === '' ||
            typeof externalRaw === 'object'
          ) {
            report.skippedUnresolvedId++;
            report.skipped++;
            if (!output.isAgentMode() && report.skippedUnresolvedId <= 3) {
              const hint = !idField
                ? 'no profile found'
                : typeof externalRaw === 'object'
                  ? `idField "${idField}" resolved to a nested object (stringifies to [object Object]) — profile needs a dotted path`
                  : `idField "${idField}" resolved to undefined/empty`;
              process.stderr.write(`  skip row ${report.skippedUnresolvedId}: ${hint}\n`);
            }
            continue;
          }
          const external = String(externalRaw);
          const sourceKey = `${platform}/${model}:${external}`;
          const keys = [sourceKey];
          if (identityKey) {
            const idValue = getByDotPath(hydrated, identityKey);
            if (idValue !== undefined && idValue !== null && idValue !== '' && typeof idValue !== 'object') {
              keys.push(`${deriveIdentityPrefix(identityKey)}:${String(idValue).toLowerCase()}`);
            }
          }

          const data = { ...hydrated };
          for (const k of Object.keys(data)) {
            if (k.startsWith('_') || k === 'rowid') delete data[k];
          }

          if (flags.dryRun) {
            if (await keyExists(keys)) report.updated++;
            else report.inserted++;
            continue;
          }

          try {
            const res = await upsertRecord(
              {
                type: `${platform}/${model}`,
                data,
                keys,
                sources: {
                  [sourceKey]: {
                    last_synced_at: (row._synced_at as string | undefined) ?? new Date().toISOString(),
                    metadata: { migrated_from: 'legacy-sqlite' },
                  },
                },
                tags: ['synced', platform],
                embed: false,
              },
              { embed: false },
            );
            if (res.action === 'inserted') report.inserted++;
            else report.updated++;
          } catch (err) {
            report.skippedError++;
            report.skipped++;
            if (!output.isAgentMode()) {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(`  skip ${sourceKey}: ${msg}\n`);
            }
          }
        }
        reports.push(report);
        if (!output.isAgentMode()) {
          const breakdown =
            report.skipped > 0
              ? ` skipped (${report.skippedUnresolvedId} unresolved id, ${report.skippedError} errors)`
              : ' skipped';
          process.stderr.write(
            `  ${platform}/${model}: ${report.inserted} inserted, ${report.updated} updated, ${report.skipped}${breakdown} (${report.rowsSeen} seen)\n`,
          );
          if (report.skippedUnresolvedId === report.rowsSeen && report.rowsSeen > 0) {
            process.stderr.write(
              `    ⚠  Every row skipped — profile for ${platform}/${model} is missing or its idField doesn't resolve on legacy rows.\n`,
            );
          }
        }
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }

  if (flags.cleanup) {
    if (!flags.dryRun) {
      const confirm = flags.yes ?? (await p.confirm({
        message: 'Delete legacy .one/sync/data/*.db files now?',
        initialValue: false,
      }));
      if (p.isCancel(confirm) || !confirm) {
        output.note('Leaving legacy files in place. Run with --cleanup --yes to force.', 'one mem migrate');
      } else {
        const dataDir = path.join('.one', 'sync', 'data');
        if (fs.existsSync(dataDir)) {
          for (const file of fs.readdirSync(dataDir)) {
            const full = path.join(dataDir, file);
            try { fs.unlinkSync(full); } catch { /* ignore */ }
          }
        }
      }
    }
  }

  okJson({
    status: flags.dryRun ? 'dry-run' : 'ok',
    reports,
    totals: {
      inserted: reports.reduce((a, r) => a + r.inserted, 0),
      updated: reports.reduce((a, r) => a + r.updated, 0),
      skipped: reports.reduce((a, r) => a + r.skipped, 0),
      skippedUnresolvedId: reports.reduce((a, r) => a + r.skippedUnresolvedId, 0),
      skippedError: reports.reduce((a, r) => a + r.skippedError, 0),
      seen: reports.reduce((a, r) => a + r.rowsSeen, 0),
    },
  });
}

/**
 * Rehydrate top-level columns that legacy SQLite stored as JSON-stringified
 * text (see sync/db.ts:prepareValue — every non-primitive value is
 * JSON.stringify'd before INSERT). Without this, dot-paths like
 * `id.record_id` return undefined because `row.id` is a string, not the
 * nested object the live API returned.
 *
 * Only top-level fields are rehydrated — that matches the legacy storage
 * shape. Values that don't parse or don't look like JSON containers
 * (don't start with `{` or `[`) are left alone. We don't recurse because
 * legacy rows never nest further.
 */
export function reviveStringifiedJson(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) continue;
    try {
      out[key] = JSON.parse(trimmed);
    } catch {
      // Not JSON — could just be a string that happens to start with [ (e.g. markdown).
      // Leave the original string in place.
    }
  }
  return out;
}

function deriveIdentityPrefix(path: string): string {
  // Default heuristic: email-shaped paths get "email:", otherwise "id:".
  const lower = path.toLowerCase();
  if (lower.includes('email')) return 'email';
  if (lower.includes('phone')) return 'phone';
  if (lower.includes('domain')) return 'domain';
  return 'id';
}
