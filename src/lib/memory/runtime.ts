/**
 * Process-local backend singleton + embedding orchestration.
 *
 * CLI commands call `getBackend()` which lazily loads + initializes the
 * configured backend (runs `ensureSchema` once per process). `addRecord()`
 * and `upsertRecord()` wrap the backend with embedding generation when
 * configured.
 */

import type { MemBackend, UpsertResult } from './backend.js';
import type { MemRecord, RecordInput } from './types.js';
import {
  getMemoryConfig,
  getMemoryConfigOrDefault,
} from './config.js';
import { loadBackendFromConfig } from './plugins.js';
import { embed, defaultSearchableText } from './embedding.js';
import { contentHash } from './canonical.js';

let cached: Promise<MemBackend> | null = null;

export async function getBackend(): Promise<MemBackend> {
  if (cached) return cached;
  const cfg = getMemoryConfig();
  if (!cfg) {
    throw new Error('Memory is not configured. Run `one mem init` first.');
  }
  cached = (async () => {
    const backend = await loadBackendFromConfig(cfg);
    await backend.init();
    await backend.ensureSchema();
    return backend;
  })();
  return cached;
}

/** Resets the singleton — used in tests. */
export function resetBackendSingleton(): void {
  cached = null;
}

// ─── Embedding-aware helpers ───────────────────────────────────────────────

export interface AddOptions {
  embed?: boolean;
  embeddingModel?: string;
}

/**
 * Derive the searchable text + content hash + embedding (if enabled) and
 * call `backend.insert`. Used by `one mem add` and by any code path that
 * wants to insert a "fresh" record without upsert semantics.
 */
export async function addRecord(input: RecordInput, opts: AddOptions = {}): Promise<MemRecord> {
  const backend = await getBackend();
  const { searchable_text, content_hash, embedding, embedding_model } = await prepareRecord(input, opts, 'add');

  // Merge derived fields into the insert payload, respecting caller overrides.
  const prepared: RecordInput & { embedding?: number[] | null; embedding_model?: string | null } = {
    ...input,
    searchable_text: input.searchable_text ?? searchable_text,
    content_hash: input.content_hash ?? content_hash,
    embedding,
    embedding_model,
  };
  return backend.insert(prepared);
}

export async function upsertRecord(input: RecordInput, opts: AddOptions = {}): Promise<UpsertResult> {
  const backend = await getBackend();
  const { searchable_text, content_hash, embedding, embedding_model } = await prepareRecord(input, opts, 'sync');

  const prepared: RecordInput & { embedding?: number[] | null; embedding_model?: string | null } = {
    ...input,
    searchable_text: input.searchable_text ?? searchable_text,
    content_hash: input.content_hash ?? content_hash,
    embedding,
    embedding_model,
  };
  return backend.upsertByKeys(prepared);
}

type PrepareContext = 'add' | 'sync';

interface PreparedFields {
  searchable_text: string;
  content_hash: string;
  embedding: number[] | null;
  embedding_model: string | null;
}

async function prepareRecord(
  input: RecordInput,
  opts: AddOptions,
  ctx: PrepareContext,
): Promise<PreparedFields> {
  const cfg = getMemoryConfigOrDefault();
  const searchable_text = input.searchable_text ?? defaultSearchableText(input.data);
  const content_hash = input.content_hash ?? contentHash(input.data);

  // Embedding gate. Precedence (highest first):
  //   explicit opts.embed → input.embed → config default for the context
  const wantEmbed =
    opts.embed ??
    input.embed ??
    (ctx === 'add' ? cfg.defaults.embedOnAdd : cfg.defaults.embedOnSync);

  if (!wantEmbed || cfg.embedding.provider === 'none' || !searchable_text) {
    return { searchable_text, content_hash, embedding: null, embedding_model: null };
  }

  const result = await embed(searchable_text, { model: opts.embeddingModel });
  if (!result) return { searchable_text, content_hash, embedding: null, embedding_model: null };
  return { searchable_text, content_hash, embedding: result.vector, embedding_model: result.model };
}
