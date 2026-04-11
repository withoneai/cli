import type { OneApi } from '../api.js';
import { ApiError } from '../api.js';
import { isAgentMode } from '../output.js';
import type { EnrichConfig } from './types.js';
import type { ActionDetails } from '../types.js';

/**
 * Rate-limit-aware enrichment engine. Fetches detail records for a batch of
 * lightweight records from a list endpoint, merging the response into each
 * record before it's stored in SQLite.
 *
 * Rate limiting is first-class:
 * - Honors Retry-After headers from 429 responses
 * - Exponential backoff (2s → 4s → 8s → ...) on rate limits
 * - Configurable concurrency (default 3) to stay within platform rate windows
 * - Per-record retry up to 3 times before skipping (logs the skip, doesn't abort the sync)
 * - Adaptive throttle: if any request in a batch hits 429, halves concurrency for the rest of the page
 */

const DEFAULT_CONCURRENCY = 3;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Interpolate {{field}} placeholders in a value using the record's fields. */
function interpolate(template: string, record: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
    const parts = path.split('.');
    let value: unknown = record;
    for (const part of parts) {
      if (typeof value !== 'object' || value === null) return '';
      value = (value as Record<string, unknown>)[part];
    }
    return value === null || value === undefined ? '' : String(value);
  });
}

/** Interpolate all values in a Record<string, string|number|boolean>. */
function interpolateParams(
  template: Record<string, string | number | boolean> | undefined,
  record: Record<string, unknown>,
): Record<string, string | number | boolean> | undefined {
  if (!template) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(template)) {
    out[key] = typeof value === 'string' ? interpolate(value, record) : value;
  }
  return out;
}

/** Deep merge source into target (source wins on conflict). */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export interface EnrichResult {
  enriched: number;
  skipped: number;
  rateLimited: number;
}

/**
 * Enrich a batch of records by calling a detail endpoint for each one.
 * Modifies records in place (merges detail data into each record).
 *
 * Rate limiting strategy:
 * 1. Run up to `concurrency` requests in parallel
 * 2. On 429: honor Retry-After, exponential backoff, halve concurrency
 * 3. On 3 consecutive failures for a record: skip it (don't abort sync)
 * 4. Between batches: insert a small delay to be a good API citizen
 */
export async function enrichRecords(
  api: OneApi,
  config: EnrichConfig,
  records: Record<string, unknown>[],
  connectionKey: string,
  platform: string,
): Promise<EnrichResult> {
  if (records.length === 0) return { enriched: 0, skipped: 0, rateLimited: 0 };

  // Preload the detail action once for all records
  let detailAction: ActionDetails;
  try {
    detailAction = await api.getActionDetails(config.actionId);
  } catch (err) {
    throw new Error(
      `Enrich: could not load action ${config.actionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  let enriched = 0;
  let skipped = 0;
  let rateLimited = 0;

  // Process records in chunks of `concurrency`
  for (let i = 0; i < records.length; i += concurrency) {
    const chunk = records.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      chunk.map(record => enrichSingleRecord(api, detailAction, config, record, connectionKey, platform)),
    );

    let hitRateLimit = false;
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        if (result.value === 'enriched') enriched++;
        else if (result.value === 'rate-limited') { skipped++; rateLimited++; hitRateLimit = true; }
        else skipped++; // 'skipped'
      } else {
        skipped++;
      }
    }

    // Adaptive throttle: if we hit a rate limit in this batch, halve concurrency
    // (minimum 1) and add a cooldown before the next batch
    if (hitRateLimit) {
      concurrency = Math.max(1, Math.floor(concurrency / 2));
      if (!isAgentMode()) {
        process.stderr.write(`  Enrich: rate limited — reducing concurrency to ${concurrency}\n`);
      }
      await sleep(BASE_BACKOFF_MS * 2);
    } else if (i + concurrency < records.length) {
      // Small delay between batches to avoid burst-triggering rate limits
      await sleep(config.delayMs ?? 200);
    }
  }

  return { enriched, skipped, rateLimited };
}

async function enrichSingleRecord(
  api: OneApi,
  detailAction: ActionDetails,
  config: EnrichConfig,
  record: Record<string, unknown>,
  connectionKey: string,
  platform: string,
): Promise<'enriched' | 'skipped' | 'rate-limited'> {
  const pathVars = interpolateParams(config.pathVars, record);
  const queryParams = interpolateParams(config.queryParams, record);
  const body = config.body
    ? JSON.parse(interpolate(JSON.stringify(config.body), record))
    : undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await api.executePassthroughRequest({
        platform,
        actionId: config.actionId,
        connectionKey,
        pathVariables: pathVars,
        queryParams,
        data: body,
      }, detailAction);

      // Extract the detail data — use resultsPath if provided, otherwise use the whole response
      let detailData: Record<string, unknown>;
      if (config.resultsPath) {
        const extracted = getByDotPath(result.responseData, config.resultsPath);
        detailData = (typeof extracted === 'object' && extracted !== null && !Array.isArray(extracted))
          ? extracted as Record<string, unknown>
          : { _enriched: extracted };
      } else {
        detailData = (typeof result.responseData === 'object' && result.responseData !== null)
          ? result.responseData as Record<string, unknown>
          : {};
      }

      // Merge into the original record (mutates in place)
      if (config.merge !== false) {
        const merged = deepMerge(record, detailData);
        Object.assign(record, merged);
      } else {
        // Replace mode — overwrite with detail data, keeping the id
        const idField = Object.keys(record)[0]; // preserve at least the first key
        Object.assign(record, detailData, { [idField]: record[idField] });
      }

      return 'enriched';
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        // Rate limited — backoff and retry
        const retryAfter = err.retryAfterSeconds ?? Math.min(BASE_BACKOFF_MS / 1000 * Math.pow(2, attempt), 60);
        await sleep(retryAfter * 1000);
        if (attempt === MAX_RETRIES - 1) return 'rate-limited';
        continue;
      }
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        // Auth error — skip this record, don't retry
        return 'skipped';
      }
      if (attempt === MAX_RETRIES - 1) {
        // Final attempt failed — skip
        return 'skipped';
      }
      // Transient error — backoff and retry
      await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
    }
  }

  return 'skipped';
}

/** Simple dot-path accessor (same as the one in dot-path.ts but avoids circular deps) */
function getByDotPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
