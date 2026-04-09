import type { OneApi } from '../api.js';
import { ApiError } from '../api.js';
import type { ActionDetails } from '../types.js';
import { getByDotPath } from '../dot-path.js';
import { getNextPageParams } from './pagination.js';
import type { SyncProfile } from './types.js';

export interface SyncTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SyncTestReport {
  platform: string;
  model: string;
  ok: boolean;
  checks: SyncTestCheck[];
  sample?: Record<string, unknown>;
  detectedColumns?: Array<{ name: string; type: string }>;
  paginationPreview?: Record<string, unknown>;
}

function detectColumnType(value: unknown): string {
  if (value === null || value === undefined) return 'TEXT';
  if (typeof value === 'string') return 'TEXT';
  if (typeof value === 'boolean') return 'INTEGER';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL';
  if (typeof value === 'object') return 'TEXT (JSON)';
  return 'TEXT';
}

/**
 * Validate a sync profile by fetching one page and checking shape.
 * Does not write to the database.
 */
export async function testSyncProfile(api: OneApi, profile: SyncProfile): Promise<SyncTestReport> {
  const checks: SyncTestCheck[] = [];
  const report: SyncTestReport = {
    platform: profile.platform,
    model: profile.model,
    ok: false,
    checks,
  };

  // Build initial params exactly like the runner does
  const queryParams: Record<string, unknown> = { ...profile.queryParams };
  const bodyParams: Record<string, unknown> = { ...profile.body };
  const pageSize = profile.defaultLimit ?? 10;
  const limitLocation = profile.limitLocation || 'query';
  let limitParam: string;
  if (profile.limitParam !== undefined) {
    limitParam = profile.limitParam;
  } else if (profile.pagination.type === 'none') {
    limitParam = '';
  } else {
    limitParam = 'limit';
  }
  if (limitParam) {
    if (limitLocation === 'body') bodyParams[limitParam] = pageSize;
    else queryParams[limitParam] = pageSize;
  }

  // Check 1: the action resolves
  let actionDetails: ActionDetails | undefined;
  try {
    actionDetails = await api.getActionDetails(profile.actionId);
    checks.push({ name: 'action resolves', ok: true });
  } catch (err) {
    checks.push({
      name: 'action resolves',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  // Check 2: single-page fetch succeeds
  let responseData: unknown;
  try {
    const result = await api.executePassthroughRequest({
      platform: profile.platform,
      actionId: profile.actionId,
      connectionKey: profile.connectionKey,
      pathVariables: profile.pathVars,
      queryParams,
      data: Object.keys(bodyParams).length > 0 ? bodyParams : undefined,
    }, actionDetails);
    responseData = result.responseData;
    checks.push({ name: 'single-page fetch', ok: true });
  } catch (err) {
    const detail =
      err instanceof ApiError
        ? `HTTP ${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    checks.push({ name: 'single-page fetch', ok: false, detail });
    return report;
  }

  // Check 3: resultsPath resolves to an array
  const records = getByDotPath(responseData, profile.resultsPath);
  if (!Array.isArray(records)) {
    const topKeys =
      typeof responseData === 'object' && responseData !== null ? Object.keys(responseData as object) : [];
    checks.push({
      name: `resultsPath "${profile.resultsPath}" → array`,
      ok: false,
      detail: `Not an array. Response keys: [${topKeys.join(', ')}]`,
    });
    return report;
  }
  checks.push({
    name: `resultsPath "${profile.resultsPath}" → array`,
    ok: true,
    detail: `${records.length} records`,
  });

  if (records.length === 0) {
    checks.push({ name: 'sample record available', ok: false, detail: 'empty result set' });
    report.ok = checks.every(c => c.ok === true || c.name === 'sample record available');
    return report;
  }

  const first = records[0] as Record<string, unknown>;

  // Check 4: idField exists on sample
  const idValue = first[profile.idField];
  if (idValue === undefined || idValue === null) {
    checks.push({
      name: `idField "${profile.idField}" present`,
      ok: false,
      detail: `Not found. Available fields: [${Object.keys(first).slice(0, 20).join(', ')}]`,
    });
  } else {
    checks.push({
      name: `idField "${profile.idField}" present`,
      ok: true,
      detail: `sample value: ${String(idValue).slice(0, 60)}`,
    });
  }

  // Check 5: pagination produces a next-page or cleanly signals "done"
  const nextParams = getNextPageParams(responseData, profile.pagination, 0, pageSize, records);
  if (profile.pagination.type === 'none') {
    checks.push({ name: 'pagination type: none', ok: true });
  } else if (nextParams) {
    checks.push({
      name: `pagination "${profile.pagination.type}" → next page`,
      ok: true,
      detail: JSON.stringify(nextParams).slice(0, 120),
    });
    report.paginationPreview = nextParams as Record<string, unknown>;
  } else {
    // Not necessarily a failure — could just be single page of data
    checks.push({
      name: `pagination "${profile.pagination.type}"`,
      ok: true,
      detail: 'no next page (single-page result or end-of-data)',
    });
  }

  // Fill detected columns and sample
  report.detectedColumns = Object.entries(first).map(([name, value]) => ({
    name,
    type: detectColumnType(value),
  }));
  report.sample = first;
  report.ok = checks.every(c => c.ok);

  return report;
}
