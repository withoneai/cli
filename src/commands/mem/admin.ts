/**
 * Admin / maintenance `one mem` commands: vacuum, reindex.
 */

import * as output from '../../lib/output.js';
import { getBackend } from '../../lib/memory/runtime.js';
import { embed } from '../../lib/memory/embedding.js';
import { getMemoryConfigOrDefault } from '../../lib/memory/index.js';
import { okJson, parsePositiveInt, requireMemoryInit } from './util.js';

export async function memVacuumCommand(): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  // VACUUM cannot run inside a transaction. For PGlite single-writer this
  // is fine; for Postgres pool, pg uses auto-commit by default.
  try {
    await backend.vacuum();
    okJson({ status: 'ok' });
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
  }
}

interface ReindexFlags {
  /** Embedding model to write. Defaults to the configured embedding.model. */
  model?: string;
  /** Restrict to one record type (e.g. attio/attioPeople). */
  type?: string;
  /** Re-embed every eligible row, even if it already has an embedding. */
  force?: boolean;
  /** OpenAI calls per iteration. Higher = faster, more likely to rate-limit. */
  batch?: string;
  /** Safety cap on total records to process. */
  limit?: string;
}

/**
 * Backfill embeddings across records that are missing them (or whose
 * embedding_model doesn't match the configured one). Designed to fix
 * the "synced data landed with embedOnSync:false, now I want semantic
 * search over it" flow.
 *
 * Lean read path: uses `backend.listForReindex` which pulls ONLY the
 * columns needed (id, type, searchable_text, content_hash,
 * embedding_model). The previous implementation pulled the full `data`
 * JSONB per row, which triggered WASM memory-access corruption on
 * PGlite at Attio-scale — the column was never actually needed since
 * embedding only consumes `searchable_text`. Writes go through
 * `updateEmbedding` for the same reason (no round-trip of `data`).
 */
export async function memReindexCommand(flags: ReindexFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const cfg = getMemoryConfigOrDefault();
  if (cfg.embedding.provider !== 'openai') {
    output.error('Reindex requires an embedding provider. Run `one mem config set embedding.provider openai` first (and `one mem config set embedding.apiKey sk-...` if no key).');
  }
  const targetModel = flags.model ?? cfg.embedding.model;
  const batchSize = flags.batch ? parsePositiveInt(flags.batch, 50, 'batch') : 50;
  const totalCap = flags.limit ? parsePositiveInt(flags.limit, 100_000, 'limit') : 100_000;

  let reembedded = 0;
  let skipped = 0;
  let considered = 0;
  let offset = 0;

  while (considered < totalCap) {
    const pageSize = Math.min(batchSize * 4, totalCap - considered);
    const rows = await backend.listForReindex({
      type: flags.type,
      limit: pageSize,
      offset,
    });
    if (rows.length === 0) break;
    considered += rows.length;
    offset += rows.length;

    // Filter to rows that need work: no embedding OR wrong model OR --force.
    const candidates = rows.filter(r => {
      if (!r.searchable_text) return false;
      if (flags.force) return true;
      if (!r.embedding_model) return true;
      if (r.embedding_model !== `openai:${targetModel}`) return true;
      return false;
    });

    // Batch the OpenAI calls to stay under rate limits / latency caps.
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      await Promise.all(batch.map(async r => {
        const res = await embed(r.searchable_text as string, { model: targetModel });
        if (!res) { skipped++; return; }
        await backend.updateEmbedding(r.id, res.vector, res.model);
        reembedded++;
      }));
      if (!output.isAgentMode()) {
        process.stderr.write(`  re-embedded ${reembedded} / considered ${considered}\r`);
      }
    }

    // Rows we looked at but didn't need work — count them for reporting.
    skipped += rows.length - candidates.length;
  }

  if (!output.isAgentMode()) {
    process.stderr.write('\n');
  }

  okJson({
    status: 'ok',
    model: targetModel,
    type: flags.type ?? null,
    considered,
    reembedded,
    skipped,
    force: !!flags.force,
  });
}
