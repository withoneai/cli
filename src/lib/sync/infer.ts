import type { PaginationConfig } from './types.js';

/**
 * Best-effort heuristics to infer sync profile fields from an action's
 * knowledge markdown. These are *hints* — the agent should still verify
 * with `one sync test <platform>/<model>` before running a full sync.
 */

export interface InferredProfileHints {
  pagination?: Partial<PaginationConfig> & { type: PaginationConfig['type'] };
  resultsPath?: string;
  idField?: string;
  dateFilterParam?: string;
  /** Where to send the page-size/limit param: "query" (default) or "body" (for POST-body list endpoints). */
  limitLocation?: 'query' | 'body';
  /** Name of the page-size param, e.g. "page_size", "limit", "maxResults". */
  limitParam?: string;
  reasoning: string[];
}

/** Known pagination patterns keyed by common tell-tale parameter/response names. */
const PAGINATION_PATTERNS: Array<{
  match: RegExp;
  config: Partial<PaginationConfig> & { type: PaginationConfig['type'] };
  label: string;
}> = [
  // Notion-style: start_cursor + next_cursor in body (POST endpoints)
  {
    match: /start_cursor|next_cursor/i,
    config: {
      type: 'cursor',
      nextPath: 'next_cursor',
      passAs: 'body:start_cursor',
      hasMorePath: 'has_more',
    },
    label: 'Notion-style body cursor pagination (start_cursor/next_cursor)',
  },
  // Stripe-style: starting_after cursor returning has_more (checked AFTER Notion so we don't match has_more alone)
  {
    match: /starting_after/i,
    config: {
      type: 'id',
      passAs: 'query:starting_after',
      hasMorePath: 'has_more',
      idField: 'id',
    },
    label: 'Stripe-style id pagination (starting_after + has_more)',
  },
  // Shopify/GitHub Link-header cursor
  {
    match: /link:\s*<[^>]+>;\s*rel="next"|page_info=/i,
    config: { type: 'link', nextPath: 'headers.link', passAs: 'query:page_info' },
    label: 'Link header cursor pagination',
  },
  // HubSpot / Google: next page token
  {
    match: /next_page_token|nextPageToken|paging\.next\.after/i,
    config: {
      type: 'token',
      nextPath: 'paging.next.after',
      passAs: 'query:after',
    },
    label: 'token/after pagination (HubSpot/Google style)',
  },
  // Generic cursor
  {
    match: /next_cursor|nextCursor|cursor/i,
    config: { type: 'cursor', nextPath: 'next_cursor', passAs: 'query:cursor' },
    label: 'generic cursor pagination',
  },
  // Offset/limit
  {
    match: /offset.*limit|page.*per_page/i,
    config: { type: 'offset', passAs: 'query:offset' },
    label: 'offset/limit pagination',
  },
];

/** Try to infer the results array path from knowledge (e.g. "data", "results", "items"). */
function inferResultsPath(knowledge: string): string | undefined {
  const candidates = ['data', 'results', 'items', 'records', 'rows', 'entries'];
  for (const key of candidates) {
    // Look for JSON-like "data": [ or "results": [
    const re = new RegExp(`"${key}"\\s*:\\s*\\[`, 'i');
    if (re.test(knowledge)) return key;
  }
  return undefined;
}

/** Try to infer the ID field from knowledge. */
function inferIdField(knowledge: string): string | undefined {
  // Prefer "id" if any "id" field appears in a schema-like context
  if (/"id"\s*:/.test(knowledge)) return 'id';
  if (/\b_id\b/.test(knowledge)) return '_id';
  if (/\buuid\b/i.test(knowledge)) return 'uuid';
  return undefined;
}

/** Try to infer a date filter parameter for incremental sync. */
function inferDateFilter(knowledge: string): string | undefined {
  const candidates = ['updated_since', 'updatedSince', 'modified_since', 'since', 'updated_after', 'created_after'];
  for (const c of candidates) {
    if (new RegExp(`\\b${c}\\b`, 'i').test(knowledge)) return c;
  }
  return undefined;
}

export function inferProfileFromKnowledge(knowledge: string | undefined): InferredProfileHints {
  const hints: InferredProfileHints = { reasoning: [] };
  if (!knowledge) {
    hints.reasoning.push('No knowledge available; all fields left as FILL_IN.');
    return hints;
  }

  for (const pattern of PAGINATION_PATTERNS) {
    if (pattern.match.test(knowledge)) {
      hints.pagination = pattern.config;
      hints.reasoning.push(`Pagination: ${pattern.label}`);
      break;
    }
  }

  const resultsPath = inferResultsPath(knowledge);
  if (resultsPath) {
    hints.resultsPath = resultsPath;
    hints.reasoning.push(`resultsPath: "${resultsPath}" (found in response schema)`);
  }

  const idField = inferIdField(knowledge);
  if (idField) {
    hints.idField = idField;
    hints.reasoning.push(`idField: "${idField}"`);
  }

  const dateFilter = inferDateFilter(knowledge);
  if (dateFilter) {
    hints.dateFilterParam = dateFilter;
    hints.reasoning.push(`dateFilter candidate: "${dateFilter}" (for incremental sync)`);
  }

  // Detect POST-body list endpoints: if the knowledge says POST and mentions a body param
  // like page_size / pageSize / limit, the limit should be sent in the body, not query.
  const isPost = /\bPOST\b/.test(knowledge);
  if (isPost) {
    const bodyLimitMatch = knowledge.match(/\b(page_size|pageSize|limit|max_results|maxResults)\b/);
    if (bodyLimitMatch) {
      hints.limitLocation = 'body';
      hints.limitParam = bodyLimitMatch[1];
      hints.reasoning.push(
        `limitLocation: "body" (POST endpoint — page size "${bodyLimitMatch[1]}" goes in request body)`
      );
      // If the Notion pattern matched, its passAs is already body:start_cursor. If another
      // cursor/token pattern matched but this is a POST, switch its passAs to body: as well.
      if (hints.pagination && hints.pagination.passAs && hints.pagination.passAs.startsWith('query:')) {
        const paramName = hints.pagination.passAs.slice('query:'.length);
        hints.pagination.passAs = `body:${paramName}`;
        hints.reasoning.push(`adjusted pagination passAs to "body:${paramName}" (POST endpoint)`);
      }
    }
  }

  if (hints.reasoning.length === 0) {
    hints.reasoning.push('Could not infer any fields from knowledge — fill template manually.');
  }

  return hints;
}
