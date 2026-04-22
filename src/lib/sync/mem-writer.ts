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

import { upsertRecord } from '../memory/runtime.js';
import type { SyncProfile } from './types.js';
import { getByDotPath } from '../dot-path.js';

export interface MemWriteReport {
  attempted: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export async function writePageToMemory(
  profile: SyncProfile,
  records: Array<Record<string, unknown>>,
): Promise<MemWriteReport> {
  const report: MemWriteReport = { attempted: 0, inserted: 0, updated: 0, skipped: 0 };
  const type = `${profile.platform}/${profile.model}`;
  const identityKey = profile.identityKey;
  const embedFlag = deriveEmbedFlag(profile);

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

    try {
      const res = await upsertRecord(
        {
          type,
          data,
          keys,
          sources: {
            [sourceKey]: {
              last_synced_at: new Date().toISOString(),
              metadata: { source: profile.platform },
            },
          },
          tags: ['synced', profile.platform],
          embed: embedFlag,
        },
        { embed: embedFlag },
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
  // Profiles can opt in per-type via `memory.embed: true`. Absent, defer to
  // the runtime's config default.
  const mem = (profile as unknown as { memory?: { embed?: boolean } }).memory;
  if (mem && typeof mem.embed === 'boolean') return mem.embed;
  return false;
}

function deriveIdentityPrefix(dotPath: string): string {
  const lower = dotPath.toLowerCase();
  if (lower.includes('email')) return 'email';
  if (lower.includes('phone')) return 'phone';
  if (lower.includes('domain')) return 'domain';
  return 'id';
}
