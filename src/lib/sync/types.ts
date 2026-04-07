export type PaginationType = 'cursor' | 'token' | 'offset' | 'id' | 'link' | 'none';

export interface PaginationConfig {
  type: PaginationType;
  /** Dot-path to the next page indicator in the response */
  nextPath?: string;
  /** Format: "{location}:{paramName}" where location is query or header */
  passAs?: string;
  /** For offset pagination: dot-path to total count in response */
  totalPath?: string;
  /** For id pagination: which field on the record is the ID */
  idField?: string;
  /** For id pagination: dot-path to has_more boolean in response */
  hasMorePath?: string;
}

export interface DateFilterConfig {
  param: string;
  format: 'iso8601' | 'unix' | 'date';
}

export interface SyncProfile {
  platform: string;
  model: string;
  connectionKey: string;
  actionId: string;
  /** Dot-path to the array of records in the API response */
  resultsPath: string;
  /** Which field on each record is the unique ID */
  idField: string;
  pagination: PaginationConfig;
  dateFilter?: DateFilterConfig;
  /** Page size per request (default: 100) */
  defaultLimit?: number;
  /** Query param name for page size (default: "limit") */
  limitParam?: string;
  /** Static path variables needed for the action */
  pathVars?: Record<string, string | number | boolean>;
  /** Additional static query params to include on every request */
  queryParams?: Record<string, unknown>;
  /** Request body for POST endpoints (pagination params merge into this) */
  body?: Record<string, unknown>;
  /** Where to send the limit param: "query" (default) or "body" */
  limitLocation?: 'query' | 'body';
}

export interface ModelSyncState {
  lastSync: string | null;
  lastCursor: unknown;
  totalRecords: number;
  pagesProcessed: number;
  since: string | null;
  status: 'idle' | 'syncing' | 'failed';
}

export type SyncState = Record<string, Record<string, ModelSyncState>>;

export interface SyncRunResult {
  model: string;
  recordsSynced: number;
  pagesProcessed: number;
  duration: string;
  status: 'complete' | 'failed' | 'dry-run';
}

export interface SyncRunOptions {
  models?: string[];
  since?: string;
  force?: boolean;
  maxPages?: number;
  dryRun?: boolean;
}

export interface SyncQueryOptions {
  where?: string;
  after?: string;
  before?: string;
  limit?: number;
  orderBy?: string;
  order?: 'asc' | 'desc';
  refresh?: boolean;
  refreshForce?: boolean;
  dateField?: string;
}

export interface ParsedPassAs {
  location: 'query' | 'header' | 'body';
  paramName: string;
}

export interface DiscoveredModel {
  name: string;
  displayName: string;
  listAction: {
    actionId: string;
    path: string;
    method: string;
  };
}
