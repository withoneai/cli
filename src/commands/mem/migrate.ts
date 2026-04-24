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
  /**
   * Rows that would have been a fresh insert under key-overlap semantics
   * but were merged into an existing row because their identityKey value
   * matched. Heals the common "re-migrate after idField fix" case where
   * old rows have garbage sourceKeys and no identity keys at all.
   */
  mergedByIdentity: number;
  skipped: number;
  /** Rows skipped because the idField path resolved to nothing (missing profile, bad path, nested). */
  skippedUnresolvedId: number;
  /** Rows skipped because the upsert threw (key conflict, schema violation, etc). */
  skippedError: number;
  /** Active count for this type before migrate ran (for doubling detection). */
  activeBefore?: number;
  /** Active count for this type after migrate ran. */
  activeAfter?: number;
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
          platform, model, rowsSeen: total, inserted: 0, updated: 0, mergedByIdentity: 0,
          skipped: 0, skippedUnresolvedId: 0, skippedError: 0,
        };
        const profile = readProfile(platform, model);
        const idField = profile?.idField;
        const identityKey = profile?.identityKey;
        const type = `${platform}/${model}`;

        // Pre-migrate active count — for doubling detection post-run.
        try { report.activeBefore = await backend.count(type, { status: 'active' }); } catch { /* best effort */ }

        // Identity-merge pre-pass. Targets the re-migrate-under-different-
        // idField case: old rows have garbage sourceKeys (e.g. stringified
        // JSON blob) and no identity keys in keys[]. A fresh upsertByKeys
        // with clean sourceKey + identity doesn't overlap any existing
        // row, so it inserts a duplicate. Pre-building
        // `identityValue → existingRowId` lets us prepend the existing
        // row's keys to our new keys array, forcing the upsert's overlap
        // check to hit the update branch and merge cleanly.
        //
        // Non-fatal on failure — migrate falls back to plain key-overlap.
        const identityMap = await buildIdentityMap(backend, type, identityKey);

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
          let identityValueNorm: string | null = null;
          if (identityKey) {
            const idValue = getByDotPath(hydrated, identityKey);
            if (idValue !== undefined && idValue !== null && idValue !== '' && typeof idValue !== 'object') {
              identityValueNorm = String(idValue).toLowerCase().trim();
              keys.push(`${deriveIdentityPrefix(identityKey)}:${identityValueNorm}`);
            }
          }
          // Identity-merge: if an existing row matched this identity in the
          // pre-pass, fold in its keys so the upsert's overlap check finds
          // it. Old garbage sourceKeys stay in the row (harmless — they
          // deduplicate via the keys-array UNION in the upsert function).
          let mergeTarget = false;
          if (identityValueNorm && identityMap.has(identityValueNorm)) {
            const hit = identityMap.get(identityValueNorm)!;
            for (const k of hit.keys) keys.push(k);
            mergeTarget = true;
          }

          const data = { ...hydrated };
          for (const k of Object.keys(data)) {
            if (k.startsWith('_') || k === 'rowid') delete data[k];
          }

          if (flags.dryRun) {
            if (await keyExists(keys)) {
              if (mergeTarget) report.mergedByIdentity++;
              else report.updated++;
            } else {
              report.inserted++;
            }
            continue;
          }

          try {
            const res = await upsertRecord(
              {
                type,
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
              // `replace: true` — legacy .db is the declared source of
              // truth for the run. Without this, identity-merged rows
              // keep their garbage stringified-JSON `data` shape from
              // the pre-fix migrate because the merge would union the
              // hydrated payload with the stringified one.
              { embed: false, replace: true },
            );
            if (res.action === 'inserted') report.inserted++;
            else if (mergeTarget) report.mergedByIdentity++;
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
        // Post-migrate count — pair with activeBefore for doubling detection.
        try { report.activeAfter = await backend.count(type, { status: 'active' }); } catch { /* best effort */ }
        reports.push(report);
        if (!output.isAgentMode()) {
          const skipDetail =
            report.skipped > 0
              ? ` skipped (${report.skippedUnresolvedId} unresolved id, ${report.skippedError} errors)`
              : ' skipped';
          const mergedSuffix =
            report.mergedByIdentity > 0 ? `, ${report.mergedByIdentity} merged by identity` : '';
          process.stderr.write(
            `  ${platform}/${model}: ${report.inserted} inserted, ${report.updated} updated${mergedSuffix}, ${report.skipped}${skipDetail} (${report.rowsSeen} seen)\n`,
          );
          if (report.skippedUnresolvedId === report.rowsSeen && report.rowsSeen > 0) {
            process.stderr.write(
              `    ⚠  Every row skipped — profile for ${platform}/${model} is missing or its idField doesn't resolve on legacy rows.\n`,
            );
          }
          // Doubling detection. `inserted + mergedByIdentity` is the max
          // growth we expect; if the active count grew further than that
          // minus known merges, duplicates slipped in. Conservative: only
          // warn when before was non-trivial so fresh migrates don't trip.
          const before = report.activeBefore ?? 0;
          const after = report.activeAfter ?? 0;
          const growth = after - before;
          const expectedMaxGrowth = report.inserted;
          if (before > 10 && growth > expectedMaxGrowth + 2) {
            process.stderr.write(
              `    ⚠  Memory for ${type} grew from ${before} → ${after} (+${growth}) ` +
              `but only ${report.inserted} new inserts were logged. ` +
              `Likely a re-migrate under a different idField created duplicates. ` +
              `Inspect with:\n` +
              `      one mem sql "SELECT jsonb_typeof(data->'id') t, COUNT(*) FROM mem_records WHERE type='${type}' GROUP BY 1"\n` +
              `    Rows where t='string' are the pre-fix cohort and can be dropped.\n`,
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
      mergedByIdentity: reports.reduce((a, r) => a + r.mergedByIdentity, 0),
      skipped: reports.reduce((a, r) => a + r.skipped, 0),
      skippedUnresolvedId: reports.reduce((a, r) => a + r.skippedUnresolvedId, 0),
      skippedError: reports.reduce((a, r) => a + r.skippedError, 0),
      seen: reports.reduce((a, r) => a + r.rowsSeen, 0),
    },
  });
}

/**
 * Build a `normalized-identity-value → {id, keys}` map for every active
 * row of `type`, by reading the identityKey path out of `data JSONB`.
 *
 * This is the merge pre-pass for `mem migrate`. Old rows from a pre-fix
 * migrate have garbage sourceKeys (e.g. a stringified JSON blob) and NO
 * identity keys in their `keys[]` array, so a fresh upsert with the new
 * correct sourceKey + identity key doesn't overlap anything and inserts
 * a duplicate. With this map, the migrate loop can detect the identity
 * match and fold the existing row's keys into the new keys array,
 * forcing the upsert's overlap check to hit the update branch.
 *
 * Uses a projected jsonb expression (`data->'a'->'b'->>'c'`) so we don't
 * read the full `data` blob across rows — PGlite's WASM ran into memory
 * issues reading large JSONB columns at scale.
 *
 * Returns an empty map on any failure — migrate falls back to plain
 * key-overlap.
 */
export async function buildIdentityMap(
  backend: Awaited<ReturnType<typeof getBackend>>,
  type: string,
  identityKey: string | undefined,
): Promise<Map<string, { id: string; keys: string[] }>> {
  const map = new Map<string, { id: string; keys: string[] }>();
  if (!identityKey || !backend.capabilities().rawSql || typeof backend.raw !== 'function') {
    return map;
  }
  const jsonbExpr = dotPathToJsonbExpr(identityKey);
  if (!jsonbExpr) return map;
  try {
    const res = await backend.raw(
      `SELECT id, keys, (${jsonbExpr}) AS ident
       FROM mem_records
       WHERE type = $1 AND status = 'active'`,
      [type],
    );
    for (const row of res.rows) {
      const ident = row.ident;
      if (ident === null || ident === undefined || typeof ident !== 'string') continue;
      const norm = ident.toLowerCase().trim();
      if (!norm) continue;
      // First write wins — if two existing rows somehow share the same
      // identity value, merge only into the first and leave the second
      // as a legitimate duplicate (user problem, not ours to resolve).
      if (!map.has(norm)) {
        map.set(norm, {
          id: String(row.id),
          keys: Array.isArray(row.keys) ? (row.keys as string[]) : [],
        });
      }
    }
  } catch {
    // Swallow — the path expression might not match any row, or the
    // backend's dialect might disagree. The caller continues without
    // the merge pre-pass, and re-migrates land duplicates (existing
    // pre-fix behaviour, no regression).
  }
  return map;
}

/**
 * Translate our dot-path syntax (values.email_addresses[0].email_address)
 * to a PG jsonb accessor expression rooted at `data`:
 *   data->'values'->'email_addresses'->0->>'email_address'
 *
 * Validates each segment against /^\w+$/ (a-z, 0-9, underscore) and
 * returns null if anything looks unsafe — we inline segments into the
 * SQL, so bad input can't be parameterized. Returning null aborts the
 * identity pre-pass for that type and migrate continues without it.
 */
export function dotPathToJsonbExpr(dotPath: string): string | null {
  const parts = dotPath.split('.').flatMap(p => {
    const match = p.match(/^([^[]+)\[(\d+)\]$/);
    if (match) return [match[1], match[2]];
    return [p];
  });
  if (parts.length === 0) return null;
  let expr = 'data';
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const isLast = i === parts.length - 1;
    if (/^\d+$/.test(seg)) {
      // Array index — always -> (object/array navigation), final cast
      // happens implicitly because we compare the value in JS.
      expr += (isLast ? '->>' : '->') + seg;
    } else if (/^\w+$/.test(seg)) {
      expr += (isLast ? "->>'" : "->'") + seg + "'";
    } else {
      return null;
    }
  }
  return expr;
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
