/**
 * `one sync search <query>` — delegates to the unified memory store.
 *
 * Synced rows live in `mem_records` keyed by type = platform/model, so
 * "search across synced data" is a `backend.search(query, {type})` call
 * per requested (platform, model) pair. Hybrid FTS+semantic ranking
 * comes for free once the caller has an OpenAI key configured.
 */

import { getBackend } from '../runtime.js';
import { embed } from '../embedding.js';
import { getMemoryConfigOrDefault } from '../config.js';
import { listProfiles } from './profile.js';

export interface SearchResult {
  platform: string;
  model: string;
  record: Record<string, unknown>;
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  searchMode: 'hybrid' | 'fts_only';
}

export async function searchSyncedData(
  query: string,
  options: { platform?: string; models?: string[]; limit?: number },
): Promise<SearchResponse> {
  const limit = options.limit ?? 20;
  const backend = await getBackend();

  // Build the type filter set from profiles (so "no platform passed"
  // hits every configured model, matching the old SQLite behaviour).
  const profiles = listProfiles(options.platform);
  const modelFilter = options.models ? new Set(options.models) : null;
  const types = profiles
    .filter(p => !modelFilter || modelFilter.has(p.model))
    .map(p => `${p.platform}/${p.model}`);

  if (types.length === 0) {
    throw new Error(
      options.platform
        ? `No sync profiles found for ${options.platform}. Run 'one sync init ${options.platform} <model>' first.`
        : `No sync profiles configured. Run 'one sync init <platform> <model>' first.`,
    );
  }

  // Embed the query once and reuse across per-type searches.
  const cfg = getMemoryConfigOrDefault();
  let queryEmbedding: number[] | null = null;
  if (cfg.embedding.provider === 'openai' && backend.capabilities().vectorSearch) {
    const result = await embed(query);
    if (result) queryEmbedding = result.vector;
  }

  const allResults: SearchResult[] = [];
  for (const type of types) {
    const rows = await backend.search(query, {
      type,
      limit,
      queryEmbedding,
      trackAccess: false,
    });
    const [platform, model] = type.split('/');
    for (const row of rows) {
      allResults.push({
        platform,
        model,
        record: row.data as Record<string, unknown>,
        // mem_hybrid_search returns `combined_score` where higher is
        // better. Invert sign so the old "ORDER BY rank ASC" contract
        // keeps working for the CLI display.
        rank: -(row.combined_score ?? 0),
      });
    }
  }

  allResults.sort((a, b) => a.rank - b.rank);
  const limited = allResults.slice(0, limit);

  return {
    results: limited,
    total: limited.length,
    searchMode: queryEmbedding ? 'hybrid' : 'fts_only',
  };
}
