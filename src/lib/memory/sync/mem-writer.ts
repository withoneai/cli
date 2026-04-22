/**
 * Optional write-through to the unified memory store.
 *
 * When `one sync run --to-memory` is passed, the runner invokes this for
 * each page of records. Writes go through `upsertRecord` (which handles
 * embedding gates, content_hash, searchable_text extraction) keyed by the
 * prefixed source id plus the profile's identity key (if set).
 *
 * This is additive: the SQLite store keeps working as it does today. Once
 * the dual-write has been verified in practice we can flip sync to write
 * exclusively to memory.
 */

import { upsertRecord } from '../runtime.js';
import type { SyncProfile } from './types.js';
import { getByDotPath } from '../../dot-path.js';

export interface MemWriteReport {
  attempted: number;
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * Build the embeddable / FTS text for a synced record from agent-declared
 * dot-paths. Resolves each path, keeps string/number/boolean leaves, flattens
 * arrays of strings, drops empties. Nested objects are intentionally NOT
 * walked — the agent must declare deeper paths if they want that content
 * (otherwise we're back to the "embed everything" noise problem).
 *
 * Exported so `sync test --show-searchable` can preview the output without
 * running a real sync.
 */
export function extractSearchableFromPaths(
  record: Record<string, unknown>,
  paths: string[],
): { text: string; paths: Array<{ path: string; found: boolean; sample: string }> } {
  const parts: string[] = [];
  const perPath: Array<{ path: string; found: boolean; sample: string }> = [];

  for (const path of paths) {
    const value = getByDotPath(record, path);
    const collected: string[] = [];

    const absorb = (v: unknown): void => {
      if (v === null || v === undefined) return;
      if (typeof v === 'string') {
        const t = v.trim();
        if (t) collected.push(t);
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        collected.push(String(v));
      } else if (Array.isArray(v)) {
        for (const inner of v) absorb(inner);
      }
      // Objects are not walked on purpose — declare deeper paths if needed.
    };

    absorb(value);

    if (collected.length > 0) {
      parts.push(...collected);
      perPath.push({ path, found: true, sample: collected.join(' ').slice(0, 80) });
    } else {
      perPath.push({ path, found: false, sample: '' });
    }
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return { text, paths: perPath };
}

/**
 * Returns the declared searchable paths for a profile, or undefined when
 * nothing is configured (callers fall back to `defaultSearchableText`).
 */
export function getSearchablePaths(profile: SyncProfile): string[] | undefined {
  const paths = profile.memory?.searchable;
  if (!paths || !Array.isArray(paths) || paths.length === 0) return undefined;
  return paths;
}

export async function writePageToMemory(
  profile: SyncProfile,
  records: Array<Record<string, unknown>>,
): Promise<MemWriteReport> {
  const report: MemWriteReport = { attempted: 0, inserted: 0, updated: 0, skipped: 0 };
  const type = `${profile.platform}/${profile.model}`;
  const identityKey = profile.identityKey;
  const embedFlag = deriveEmbedFlag(profile);
  const searchablePaths = getSearchablePaths(profile);

  for (const record of records) {
    report.attempted++;
    const externalId = record[profile.idField];
    if (externalId === undefined || externalId === null || externalId === '') {
      report.skipped++;
      continue;
    }

    const sourceKey = `${type}:${String(externalId)}`;
    const keys = [sourceKey];

    if (identityKey) {
      const raw = getByDotPath(record, identityKey);
      if (raw !== null && raw !== undefined && raw !== '') {
        keys.push(`${deriveIdentityPrefix(identityKey)}:${String(raw).toLowerCase().trim()}`);
      }
    }

    // Strip sync-internal bookkeeping from the payload
    const data = { ...record };
    for (const k of Object.keys(data)) {
      if (k.startsWith('_')) delete data[k];
    }

    // When the profile declares searchable paths, extract directly so the
    // embedding + FTS text is clean. Otherwise let the runtime fall back
    // to `defaultSearchableText` which walks the whole record.
    const searchable_text = searchablePaths
      ? extractSearchableFromPaths(record, searchablePaths).text
      : undefined;

    try {
      const res = await upsertRecord(
        {
          type,
          data,
          keys,
          searchable_text,
          sources: {
            [sourceKey]: {
              last_synced_at: new Date().toISOString(),
              metadata: { source: profile.platform },
            },
          },
          tags: ['synced', profile.platform],
          embed: embedFlag,
        },
        // Sync must REPLACE: if a field vanished at the source (phone
        // number removed, Gmail thread archived) it must also vanish
        // from memory. The default merge behaviour is correct for
        // interactive `mem add` / `mem update`, wrong for sync.
        { embed: embedFlag, replace: true },
      );
      if (res.action === 'inserted') report.inserted++;
      else report.updated++;
    } catch {
      report.skipped++;
    }
  }
  return report;
}

function deriveEmbedFlag(profile: SyncProfile): boolean {
  if (profile.memory && typeof profile.memory.embed === 'boolean') return profile.memory.embed;
  return false;
}

function deriveIdentityPrefix(dotPath: string): string {
  const lower = dotPath.toLowerCase();
  if (lower.includes('email')) return 'email';
  if (lower.includes('phone')) return 'phone';
  if (lower.includes('domain')) return 'domain';
  return 'id';
}
