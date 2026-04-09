import type { OneApi } from '../api.js';
import { ApiError } from '../api.js';
import { getByDotPath } from '../dot-path.js';
import { isAgentMode } from '../output.js';
import type { SyncProfile, SyncRunResult, SyncRunOptions, ModelSyncState } from './types.js';
import { getNextPageParams } from './pagination.js';
import { getModelState, updateModelState } from './state.js';
import { openDatabase, ensureTable, rebuildFtsIndex, evolveSchema, upsertRecords, tableExists, countRecords, deleteRecords, sanitizeTableName } from './db.js';
import { acquireSyncLock } from './lock.js';
import type Database from 'better-sqlite3';

const MAX_RETRIES_PER_PAGE = 3;
const DEFAULT_SINCE_DAYS = 90;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Parse --since flag: "90d", "30d", "2026-01-01", etc. */
function parseSince(since: string): Date {
  const durationMatch = since.match(/^(\d+)([dhm])$/);
  if (durationMatch) {
    const amount = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2];
    const now = new Date();
    if (unit === 'd') now.setDate(now.getDate() - amount);
    else if (unit === 'h') now.setHours(now.getHours() - amount);
    else if (unit === 'm') now.setMonth(now.getMonth() - amount);
    return now;
  }
  return new Date(since);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds % 60).toFixed(0);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Execute a sync run for a single model.
 */
export async function syncModel(
  api: OneApi,
  profile: SyncProfile,
  options: SyncRunOptions,
): Promise<SyncRunResult> {
  const { platform, model } = profile;
  const startTime = Date.now();

  // Validate incompatible options
  if (options.fullRefresh && options.since) {
    throw new Error(
      '--full-refresh and --since cannot be used together. --full-refresh always fetches the whole collection.'
    );
  }

  // Acquire a cross-process lock so two concurrent syncs (e.g. cron tick +
  // manual run) don't race on the same table. Dry-run skips the lock since
  // it performs no writes.
  const lock = options.dryRun ? null : acquireSyncLock(platform, model);

  // Check in-process state too (cheap and gives a clearer error message)
  const existingState = getModelState(platform, model);
  if (existingState?.status === 'syncing' && !options.force) {
    if (lock) lock.release();
    throw new Error(
      `Sync state says ${platform}/${model} is already syncing. ` +
      `Use --force to override (this may happen if a previous sync crashed before cleanup).`
    );
  }

  // Warn loudly when the profile has no dateFilter — every "incremental"
  // sync will actually re-pull the entire collection. The upserts still
  // work, but the user should know they're not saving API calls.
  if (!profile.dateFilter && !options.dryRun && !options.fullRefresh && !isAgentMode()) {
    process.stderr.write(
      `⚠ ${platform}/${model} profile has no dateFilter — this sync will fetch the entire collection every run. ` +
      `Add a dateFilter to the profile for true incremental sync, or accept the full-pull cost.\n`
    );
  }

  // Don't set status for dry-run — it's just a preview
  if (!options.dryRun) {
    updateModelState(platform, model, { status: 'syncing' });
  }

  let db: Database.Database | null = null;
  let totalRecords = 0;
  let pagesProcessed = 0;
  let lastCursor: unknown = null;
  // Track every id we saw across pages, for --full-refresh deletion reconciliation.
  const seenIds = new Set<string | number>();

  try {
    db = await openDatabase(platform);

    // Determine the since date.
    // --full-refresh forces a complete pull: no dateFilter, no lastSync fallback.
    let sinceDate: Date | null = null;
    if (options.fullRefresh) {
      sinceDate = null;
    } else if (options.since) {
      sinceDate = parseSince(options.since);
    } else if (!options.force && existingState?.lastSync) {
      sinceDate = new Date(existingState.lastSync);
    } else {
      sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - DEFAULT_SINCE_DAYS);
    }

    // Build initial params (query or body depending on profile config)
    const queryParams: Record<string, unknown> = { ...profile.queryParams };
    const bodyParams: Record<string, unknown> = { ...profile.body };
    const pageSize = profile.defaultLimit ?? 100;
    const limitLocation = profile.limitLocation || 'query';
    // Resolve the limit param name. Precedence:
    //   1. Explicit profile.limitParam (including "" which means "no limit")
    //   2. If pagination type is "none", default to "" — don't inject a page
    //      size into a non-paginated request (strict APIs like Google reject it).
    //   3. Otherwise default to "limit".
    let limitParam: string;
    if (profile.limitParam !== undefined) {
      limitParam = profile.limitParam;
    } else if (profile.pagination.type === 'none') {
      limitParam = '';
    } else {
      limitParam = 'limit';
    }

    if (limitParam) {
      if (limitLocation === 'body') {
        bodyParams[limitParam] = pageSize;
      } else {
        queryParams[limitParam] = pageSize;
      }
    }

    // Apply date filter
    if (sinceDate && profile.dateFilter) {
      const { param, format } = profile.dateFilter;
      let dateValue: unknown;
      if (format === 'iso8601') {
        dateValue = sinceDate.toISOString();
      } else if (format === 'unix') {
        dateValue = Math.floor(sinceDate.getTime() / 1000);
      } else if (format === 'date') {
        dateValue = sinceDate.toISOString().split('T')[0];
      }
      if (dateValue !== undefined) {
        queryParams[param] = dateValue;
      }
    }

    // Get preloaded action details for efficiency
    const actionDetails = await api.getActionDetails(profile.actionId);
    const maxPages = options.maxPages ?? Infinity;
    let tableCreated = tableExists(db, model);

    // Pagination loop
    let currentPageQueryParams = { ...queryParams };
    let currentPageBodyParams = { ...bodyParams };
    let currentPageHeaders: Record<string, string> | undefined;

    for (let page = 0; page < maxPages; page++) {
      // Execute API request with retry logic
      let responseData: unknown;
      let retries = 0;

      while (true) {
        try {
          const hasBody = Object.keys(currentPageBodyParams).length > 0;
          const result = await api.executePassthroughRequest({
            platform,
            actionId: profile.actionId,
            connectionKey: profile.connectionKey,
            pathVariables: profile.pathVars,
            queryParams: currentPageQueryParams,
            headers: currentPageHeaders,
            data: hasBody ? currentPageBodyParams : undefined,
          }, actionDetails);

          responseData = result.responseData;
          break;
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status === 429 && retries < MAX_RETRIES_PER_PAGE) {
              // Rate limited — honor Retry-After if the server provided it,
              // otherwise use exponential backoff (30s, 60s, 120s).
              const retryAfter = err.retryAfterSeconds ?? Math.min(30 * Math.pow(2, retries), 120);
              if (!isAgentMode()) {
                process.stderr.write(`  Rate limited. Waiting ${retryAfter}s before retry...\n`);
              }
              await sleep(retryAfter * 1000);
              retries++;
              continue;
            }
            if (err.status === 401 || err.status === 403) {
              throw new Error(`Authentication failed. Connection key may be expired. Run 'one add ${platform}' to refresh.`);
            }
          }
          throw err;
        }
      }

      // Extract results
      const records = getByDotPath(responseData, profile.resultsPath);
      if (!Array.isArray(records)) {
        // Try to help the user fix the profile
        const topKeys = typeof responseData === 'object' && responseData !== null
          ? Object.keys(responseData)
          : [];
        throw new Error(
          `Could not find results at path '${profile.resultsPath}' in API response. ` +
          `Check your sync profile. Response keys: [${topKeys.join(', ')}]`
        );
      }

      if (records.length === 0 && page === 0) {
        // Empty results on first page — not an error
        if (!isAgentMode()) {
          process.stderr.write(`No records found for ${model} with the given filters.\n`);
        }
        break;
      }

      if (records.length === 0) break;

      // Dry-run: show first page results and exit
      if (options.dryRun) {
        pagesProcessed = 1;
        totalRecords = records.length;
        db.close();
        return {
          model,
          recordsSynced: totalRecords,
          pagesProcessed,
          duration: formatDuration(Date.now() - startTime),
          status: 'dry-run',
        };
      }

      // Create table on first page with actual data
      if (!tableCreated) {
        const firstRecord = records[0] as Record<string, unknown>;
        ensureTable(db, model, firstRecord, profile.idField);
        tableCreated = true;
      }

      // Evolve schema if needed (check for new fields)
      for (const record of records) {
        if (typeof record === 'object' && record !== null) {
          evolveSchema(db, model, record as Record<string, unknown>);
          break; // Only need to check one record per page for new columns
        }
      }

      // Track ids for --full-refresh reconciliation
      if (options.fullRefresh) {
        for (const rec of records as Record<string, unknown>[]) {
          const id = rec[profile.idField];
          if (typeof id === 'string' || typeof id === 'number') {
            seenIds.add(id);
          }
        }
      }

      // Upsert records
      const inserted = upsertRecords(
        db,
        model,
        records as Record<string, unknown>[],
        profile.idField,
      );
      totalRecords += inserted;
      pagesProcessed++;

      // Progress output
      if (!isAgentMode()) {
        process.stderr.write(`Syncing ${platform}/${model}... page ${pagesProcessed} (${totalRecords} records)\r`);
      }

      // Get next page params
      const nextParams = getNextPageParams(
        responseData,
        profile.pagination,
        page,
        pageSize,
        records,
      );

      // Save state after each page for crash recovery.
      // Capture the first value across query/body/header params as the cursor snapshot.
      const cursorBag =
        nextParams?.queryParams ?? nextParams?.bodyParams ?? nextParams?.headers;
      const cursorKeys = cursorBag ? Object.keys(cursorBag) : [];
      lastCursor = cursorKeys.length > 0 ? (cursorBag as Record<string, unknown>)[cursorKeys[0]] : null;
      updateModelState(platform, model, {
        totalRecords: countRecords(db, model),
        pagesProcessed,
        lastCursor,
        status: 'syncing',
      });

      if (!nextParams) break;

      // Apply next page params
      currentPageQueryParams = { ...queryParams, ...nextParams.queryParams };
      currentPageBodyParams = { ...bodyParams, ...nextParams.bodyParams };
      if (nextParams.headers) {
        currentPageHeaders = { ...currentPageHeaders, ...nextParams.headers };
      }
    }

    // --full-refresh: delete local rows whose ids weren't seen this run.
    // Only runs if we actually fetched pages (paranoia against wiping data
    // when the API returned an empty first page due to some transient issue).
    let deletedStale = 0;
    if (options.fullRefresh && pagesProcessed > 0 && tableCreated && seenIds.size > 0) {
      const safeTable = sanitizeTableName(model);
      const safeIdField = profile.idField.replace(/"/g, '""');
      // Chunk the NOT IN clause to stay under SQLite's variable limit (~999)
      const ids = Array.from(seenIds);
      const CHUNK = 500;
      const seenChunks: unknown[][] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        seenChunks.push(ids.slice(i, i + CHUNK));
      }

      // Build a temp table of seen ids and delete anything not in it
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS _seen_ids (id)`);
      db.exec(`DELETE FROM _seen_ids`);
      const insertStmt = db.prepare(`INSERT INTO _seen_ids (id) VALUES (?)`);
      const tx = db.transaction((batch: unknown[]) => {
        for (const id of batch) insertStmt.run(id as string | number);
      });
      for (const chunk of seenChunks) tx(chunk);

      const delResult = db.prepare(
        `DELETE FROM "${safeTable}" WHERE "${safeIdField}" NOT IN (SELECT id FROM _seen_ids)`
      ).run();
      deletedStale = delResult.changes;
      db.exec(`DROP TABLE IF EXISTS _seen_ids`);

      if (!isAgentMode() && deletedStale > 0) {
        process.stderr.write(`Removed ${deletedStale} stale record(s) no longer in source.\n`);
      }
    }

    // Rebuild FTS index after all data is written
    if (pagesProcessed > 0 && tableCreated) {
      rebuildFtsIndex(db, model);
    }

    // Finalize
    if (!isAgentMode() && pagesProcessed > 0) {
      process.stderr.write(`Syncing ${platform}/${model}... page ${pagesProcessed} (${totalRecords} records) done\n`);
    }

    const duration = formatDuration(Date.now() - startTime);
    const actualCount = countRecords(db, model);
    updateModelState(platform, model, {
      lastSync: new Date().toISOString(),
      totalRecords: actualCount,
      pagesProcessed,
      lastCursor: null,
      since: sinceDate?.toISOString() ?? null,
      status: 'idle',
    });

    db.close();
    if (lock) lock.release();
    return { model, recordsSynced: totalRecords, pagesProcessed, duration, status: 'complete', deletedStale };

  } catch (err) {
    // Save failed state
    const failedCount = db ? countRecords(db, model) : (existingState?.totalRecords ?? 0);
    updateModelState(platform, model, {
      status: 'failed',
      totalRecords: failedCount,
      pagesProcessed,
      lastCursor,
    });

    if (db) db.close();
    if (lock) lock.release();

    if (pagesProcessed > 0) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Sync interrupted after page ${pagesProcessed} (${totalRecords} records). ` +
        `Run again to resume. Error: ${msg}`
      );
    }

    throw err;
  }
}
