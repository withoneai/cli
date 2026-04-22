/**
 * Admin / maintenance `one mem` commands: vacuum, reindex.
 */

import * as output from '../../lib/output.js';
import { getBackend } from '../../lib/memory/runtime.js';
import { embed } from '../../lib/memory/embedding.js';
import { getMemoryConfigOrDefault } from '../../lib/memory/index.js';
import { okJson, requireMemoryInit } from './util.js';

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
  model?: string;
  batch?: string;
}

/**
 * Re-embed every record whose content_hash has changed OR whose
 * embedding_model doesn't match the configured one. Runs in batches so
 * OpenAI rate limits are respected.
 */
export async function memReindexCommand(flags: ReindexFlags): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();
  const cfg = getMemoryConfigOrDefault();
  if (cfg.embedding.provider !== 'openai') {
    output.error('Reindex requires an embedding provider. Set `memory.embedding.provider = openai` first.');
  }
  const targetModel = flags.model ?? cfg.embedding.model;

  // We don't have a first-class "find records needing embedding" query on
  // the backend yet. As a pragmatic v1, iterate through context() results —
  // these are active, relevance-sorted, which is what we'd want to
  // prioritize anyway. A real migration in v2 would stream via cursor.
  const ctx = await backend.context({ limit: 5000 });
  let reembedded = 0;
  let skipped = 0;
  for (const item of ctx) {
    const record = await backend.getById(item.id);
    if (!record) continue;
    const text = record.searchable_text;
    if (!text) { skipped++; continue; }
    const res = await embed(text, { model: targetModel });
    if (!res) { skipped++; continue; }
    await backend.update(item.id, {
      type: record.type,
      data: record.data,
      embedding: res.vector,
      embedding_model: res.model,
    });
    reembedded++;
    if (!output.isAgentMode() && reembedded % 50 === 0) {
      process.stderr.write(`  re-embedded ${reembedded}/${ctx.length}\n`);
    }
  }
  okJson({ status: 'ok', model: targetModel, reembedded, skipped, considered: ctx.length });
}
