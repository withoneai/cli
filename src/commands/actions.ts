import pc from 'picocolors';
import { getApiKey, getApiBase, getAccessControlFromAllSources } from '../lib/config.js';
import { OneApi, ApiError, isActionAllowed, isMethodAllowed } from '../lib/api.js';
import * as output from '../lib/output.js';
import type { PermissionLevel, ActionDetails, FindIntent } from '../lib/types.js';
import { validateActionInput } from '../lib/validate.js';
import { resolveActionDetails } from '../lib/action-details.js';
import {
  find,
  load,
  renderFind,
  renderLoad,
  type FindDeps,
  type FindSettings,
  type LoadOptions,
} from '../lib/find.js';
import { knowledgeCachePath, readCache, isFresh, getAge, formatAge } from '../lib/cache.js';

function getConfig() {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('Not configured. Run `one init` first.');
  }

  const ac = getAccessControlFromAllSources();
  const permissions: PermissionLevel = ac.permissions || 'admin';
  const connectionKeys: string[] = ac.connectionKeys || ['*'];
  const actionIds: string[] = ac.actionIds || ['*'];
  const knowledgeAgent: boolean = ac.knowledgeAgent || false;

  return { apiKey, permissions, connectionKeys, actionIds, knowledgeAgent };
}

function parseJsonArg(value: string, argName: string): any {
  try {
    return JSON.parse(value);
  } catch {
    output.error(`Invalid JSON for ${argName}: ${value}`);
  }
}

/** The find dependencies over the API, with action details served from the knowledge cache. */
function findDeps(api: OneApi, connectionKeys: string[], useCache: boolean): FindDeps {
  return {
    findActions: (requests, task, knowledgeAgent) => api.findActions(requests, task, knowledgeAgent),
    getActionDetails: async (actionId) => (await resolveActionDetails(api, actionId, { useCache })).details,
    connectedPlatforms: async () =>
      (await api.listConnections()).filter((c) => connectionKeys.includes(c.key)).map((c) => c.platform),
  };
}

/** The reason core gave for refusing a request, rather than its raw JSON body. */
function failure(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.message) as { message?: string };
      if (body.message) return body.message;
    } catch {
      // Not a JSON body; the text is the message.
    }
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

export interface ActionsFindOptions {
  task?: string;
  /** `knowledge` searches the catalog for writing code and building flows; `execute` (default) the one for running actions. */
  type?: string;
  /** The AI model running the CLI. Accepted and not read yet, as on the remote MCP's `find_one_actions`. */
  aiModel?: string;
  cache?: boolean;
}

/**
 * `one actions find <platform> <intent> [<platform> <intent> ...]`: the action
 * for every operation a task needs, across platforms, with its documentation.
 */
export async function actionsFindCommand(pairs: string[], options: ActionsFindOptions): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One ')));

  if (options.type !== undefined && options.type !== 'execute' && options.type !== 'knowledge') {
    output.error('--type must be execute or knowledge.');
  }
  if (pairs.length === 0 || pairs.length % 2 !== 0) {
    output.error('Pass platform and intent pairs: one actions find <platform> "<intent>" [<platform> "<intent>" ...]');
  }
  const requests: FindIntent[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    requests.push({ platform: pairs[i], intent: pairs[i + 1] });
  }

  const { apiKey, permissions, connectionKeys, actionIds, knowledgeAgent } = getConfig();
  const api = new OneApi(apiKey, getApiBase());
  const settings: FindSettings = { knowledgeAgent, permissions, actionIds, connectionKeys, apiBase: getApiBase() };

  const spinner = output.createSpinner();
  spinner.start(`Finding actions for ${requests.length} intent${requests.length === 1 ? '' : 's'}...`);

  try {
    const result = await find(
      requests,
      options.task,
      findDeps(api, connectionKeys, options.cache !== false),
      settings,
      options.type === 'knowledge'
    );

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }
    spinner.stop('Found');
    console.log();
    console.log(renderFind(result));
    console.log();
  } catch (error) {
    spinner.stop('Find failed');
    output.error(`Error: ${failure(error)}`);
  }
}

export interface ActionsLoadOptions extends LoadOptions {
  cache?: boolean;
  cacheStatus?: boolean;
}

/**
 * `one actions load <actionId...>`: more of an action's documentation - a
 * section a digest left out, the whole document, its contents, or an
 * alternative's digest.
 */
export async function actionsLoadCommand(actionIds: string[], options: ActionsLoadOptions): Promise<void> {
  // --cache-status: print each action's cache metadata and return
  if (options.cacheStatus) {
    output.json(
      actionIds.map((actionId) => {
        const cachePath = knowledgeCachePath(actionId);
        const entry = readCache<ActionDetails>(cachePath);
        if (!entry) return { actionId, cached: false, path: cachePath };
        return {
          actionId,
          cached: true,
          cachedAt: entry.cachedAt,
          age: formatAge(getAge(entry)),
          ttl: entry.ttl,
          expired: !isFresh(entry),
          etag: entry.etag,
          path: cachePath,
        };
      })
    );
    return;
  }

  output.intro(pc.bgCyan(pc.black(' One ')));

  const { apiKey, permissions, connectionKeys, actionIds: allowed, knowledgeAgent } = getConfig();
  const api = new OneApi(apiKey, getApiBase());
  const settings: FindSettings = { knowledgeAgent, permissions, actionIds: allowed, connectionKeys, apiBase: getApiBase() };

  const spinner = output.createSpinner();
  spinner.start(`Loading ${actionIds.length === 1 ? 'the action' : `${actionIds.length} actions`}...`);

  try {
    const result = await load(actionIds, options, findDeps(api, connectionKeys, options.cache !== false), settings);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }
    spinner.stop('Loaded');
    console.log();
    console.log(renderLoad(result));
    console.log();
  } catch (error) {
    spinner.stop('Load failed');
    output.error(`Error: ${failure(error)}`);
  }
}

export async function actionsExecuteCommand(
  platform: string,
  actionId: string,
  connectionKey: string,
  options: {
    data?: string;
    pathVars?: string;
    queryParams?: string;
    headers?: string;
    formData?: boolean;
    formUrlEncoded?: boolean;
    dryRun?: boolean;
    mock?: boolean;
    skipValidation?: boolean;
    output?: string;
    cache?: boolean;
  }
): Promise<void> {
  output.intro(pc.bgCyan(pc.black(' One ')));

  const { apiKey, permissions, actionIds, connectionKeys, knowledgeAgent } =
    getConfig();

  // Check knowledge-only mode
  if (knowledgeAgent) {
    output.error(
      'Action execution is disabled (knowledge-only mode).'
    );
  }

  // Check action allowlist
  if (!isActionAllowed(actionId, actionIds)) {
    output.error(`Action "${actionId}" is not in the allowed action list.`);
  }

  // Check connection key allowlist
  if (!connectionKeys.includes('*') && !connectionKeys.includes(connectionKey)) {
    output.error(`Connection key "${connectionKey}" is not allowed.`);
  }

  const api = new OneApi(apiKey, getApiBase());

  const spinner = output.createSpinner();
  spinner.start('Resolving action details...');

  try {
    // Served from the knowledge cache when fresh — in the standard
    // search → knowledge → execute flow this costs zero network.
    const { details: actionDetails, cacheHit: preflightCacheHit } =
      await resolveActionDetails(api, actionId, { useCache: options.cache !== false });

    // Check method permissions
    if (!isMethodAllowed(actionDetails.method, permissions)) {
      spinner.stop('Permission denied');
      output.error(
        `Method "${actionDetails.method}" is not allowed under "${permissions}" permission level.`
      );
    }

    spinner.stop(
      `Action: ${actionDetails.title} [${actionDetails.method}]` +
        (preflightCacheHit ? pc.dim(' (cached)') : '')
    );

    // Parse optional JSON arguments
    const data = options.data ? parseJsonArg(options.data, '--data') : undefined;
    const pathVariables = options.pathVars
      ? parseJsonArg(options.pathVars, '--path-vars')
      : undefined;
    const queryParams = options.queryParams
      ? parseJsonArg(options.queryParams, '--query-params')
      : undefined;
    const headers = options.headers
      ? parseJsonArg(options.headers, '--headers')
      : undefined;

    // Validate input against action schema
    if (!options.skipValidation) {
      const validation = validateActionInput(actionDetails, { data, pathVariables, queryParams });
      if (!validation.valid) {
        spinner.stop('Validation failed');
        if (output.isAgentMode()) {
          output.json({
            error: 'Validation failed: missing required parameters',
            validation: { missing: validation.missing },
            hint: 'Add the missing parameters, or pass --skip-validation to bypass this check.',
          });
          process.exit(1);
        }
        console.log();
        for (const m of validation.missing) {
          console.log(pc.red(`  ${m.flag} is missing "${m.param}"`));
          if (m.description) {
            console.log(pc.dim(`    ${m.description}`));
          }
        }
        console.log();
        output.error('Validation failed: missing required parameters. Pass --skip-validation to bypass.');
      }
    }

    // Mock mode — return example response without making an API call
    if (options.mock) {
      spinner.stop('Mock — returning example response');
      const mockResponse = actionDetails.ioSchema?.ioExample?.output ?? null;
      if (output.isAgentMode()) {
        output.json({
          mock: true,
          request: {
            method: actionDetails.method,
            url: actionDetails.path,
          },
          response: mockResponse,
          ...(mockResponse === null ? { message: 'No example output available for this action' } : {}),
          _preflight: { cache: preflightCacheHit ? 'hit' : 'miss' },
        });
        return;
      }
      console.log();
      if (mockResponse) {
        console.log(pc.bold('Mock Response:'));
        console.log(JSON.stringify(mockResponse, null, 2));
      } else {
        output.note('No example output available for this action', 'Mock');
      }
      return;
    }

    const execSpinner = output.createSpinner();
    execSpinner.start(options.dryRun ? 'Building request...' : 'Executing action...');

    const result = await api.executePassthroughRequest(
      {
        platform,
        actionId,
        connectionKey,
        data,
        pathVariables,
        queryParams,
        headers,
        isFormData: options.formData,
        isFormUrlEncoded: options.formUrlEncoded,
        dryRun: options.dryRun,
        output: options.output,
      },
      actionDetails
    );

    execSpinner.stop(options.dryRun ? 'Dry run — request not sent' : 'Action executed successfully');

    if (output.isAgentMode()) {
      output.json({
        dryRun: options.dryRun || false,
        request: {
          method: result.requestConfig.method,
          url: result.requestConfig.url,
          headers: options.dryRun ? result.requestConfig.headers : undefined,
          data: options.dryRun ? result.requestConfig.data : undefined,
        },
        response: options.dryRun ? undefined : result.responseData,
        _preflight: { cache: preflightCacheHit ? 'hit' : 'miss' },
      });
      return;
    }

    console.log();
    console.log(pc.dim('Request:'));
    console.log(
      pc.dim(
        `  ${result.requestConfig.method} ${result.requestConfig.url}`
      )
    );

    if (options.dryRun) {
      if (result.requestConfig.data) {
        console.log();
        console.log(pc.dim('Body:'));
        console.log(pc.dim(JSON.stringify(result.requestConfig.data, null, 2)));
      }
      console.log();
      output.note('Dry run — request was not sent', 'Dry Run');
    } else {
      console.log();
      console.log(pc.bold('Response:'));
      const rd = result.responseData as { text?: unknown; contentType?: unknown } | null;
      if (rd && typeof rd === 'object' && typeof rd.text === 'string' && 'contentType' in rd) {
        // Text body (text/plain, text/html, CSV, …) — print it inline rather
        // than as an escaped JSON string. (#163)
        if (rd.contentType) console.log(pc.dim(`(${rd.contentType})`));
        console.log(rd.text);
      } else {
        console.log(JSON.stringify(result.responseData, null, 2));
      }
    }
  } catch (error) {
    spinner.stop('Execution failed');
    output.error(
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

// ── Parallel Execute ──

interface ParsedSegment {
  platform: string;
  actionId: string;
  connectionKey: string;
  data?: string;
  pathVars?: string;
  queryParams?: string;
  headers?: string;
  formData?: boolean;
  formUrlEncoded?: boolean;
}

interface GlobalParallelFlags {
  dryRun: boolean;
  mock: boolean;
  skipValidation: boolean;
  maxConcurrency: number;
  useCache: boolean;
}

interface SegmentResult {
  segment: number;
  platform: string;
  actionId: string;
  status: 'success' | 'error';
  durationMs: number;
  dryRun?: boolean;
  mock?: boolean;
  request?: unknown;
  response?: unknown;
  error?: string;
  _preflight?: { cache: 'hit' | 'miss' };
}

function parseParallelSegments(): { segments: ParsedSegment[]; flags: GlobalParallelFlags } {
  const argv = process.argv.slice(2);

  // Find `execute` (or alias `x`) after `actions` (or alias `a`)
  let execIdx = -1;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === 'execute' || argv[i] === 'x') &&
        i > 0 && (argv[i - 1] === 'actions' || argv[i - 1] === 'a')) {
      execIdx = i;
      break;
    }
  }
  if (execIdx === -1) {
    output.error('Could not locate "actions execute" in argv');
  }

  const raw = argv.slice(execIdx + 1);

  // Strip global flags and collect their values
  const flags: GlobalParallelFlags = { dryRun: false, mock: false, skipValidation: false, maxConcurrency: 5, useCache: true };
  const cleaned: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === '--parallel' || t === '--agent') continue;
    if (t === '--dry-run') { flags.dryRun = true; continue; }
    if (t === '--mock') { flags.mock = true; continue; }
    if (t === '--skip-validation') { flags.skipValidation = true; continue; }
    if (t === '--no-cache') { flags.useCache = false; continue; }
    if (t === '--max-concurrency') { flags.maxConcurrency = parseInt(raw[++i], 10) || 5; continue; }
    cleaned.push(t);
  }

  // Split on `--` into segments
  const segmentArrays: string[][] = [];
  let current: string[] = [];
  for (const token of cleaned) {
    if (token === '--') {
      if (current.length > 0) segmentArrays.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segmentArrays.push(current);

  if (segmentArrays.length === 0) {
    output.error('--parallel requires at least one action segment. Usage: --parallel <platform> <actionId> <connectionKey> [-d ...] [-- <next action> ...]');
  }

  const segments = segmentArrays.map((tokens, i) => parseSegmentTokens(tokens, i + 1));
  return { segments, flags };
}

function parseSegmentTokens(tokens: string[], segmentIndex: number): ParsedSegment {
  if (tokens.length < 3) {
    output.error(`Segment ${segmentIndex}: expected <platform> <actionId> <connectionKey>, got ${tokens.length} token(s): ${tokens.join(' ')}`);
  }

  const segment: ParsedSegment = {
    platform: tokens[0],
    actionId: tokens[1],
    connectionKey: tokens[2],
  };

  for (let i = 3; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-d' || t === '--data') { segment.data = tokens[++i]; continue; }
    if (t === '--path-vars') { segment.pathVars = tokens[++i]; continue; }
    if (t === '--query-params') { segment.queryParams = tokens[++i]; continue; }
    if (t === '--headers') { segment.headers = tokens[++i]; continue; }
    if (t === '--form-data') { segment.formData = true; continue; }
    if (t === '--form-url-encoded') { segment.formUrlEncoded = true; continue; }
    output.error(`Segment ${segmentIndex}: unknown option "${t}"`);
  }

  return segment;
}

function tryParseJson(value: string, label: string): { value: unknown; error?: undefined } | { value?: undefined; error: string } {
  try {
    return { value: JSON.parse(value) };
  } catch {
    return { error: `Invalid JSON for ${label}: ${value}` };
  }
}

export async function actionsExecuteParallelCommand(): Promise<void> {
  const { segments, flags } = parseParallelSegments();

  const { apiKey, permissions, actionIds, connectionKeys, knowledgeAgent } = getConfig();

  if (knowledgeAgent) {
    output.error('Action execution is disabled (knowledge-only mode).');
  }

  const api = new OneApi(apiKey, getApiBase());

  // ── Phase 2: validate ALL segments upfront ──

  interface PreparedAction {
    segment: ParsedSegment;
    index: number;
    actionDetails: ActionDetails;
    preflightCacheHit: boolean;
    data?: unknown;
    pathVariables?: Record<string, unknown>;
    queryParams?: Record<string, unknown>;
    headers?: Record<string, string>;
  }

  const prepared: PreparedAction[] = [];
  const errors: { segment: number; label: string; messages: string[] }[] = [];

  // Dedupe the resolver's stale-fallback warning: when several segments share
  // one stale action (network down), warn once for that action, not per segment.
  const staleWarned = new Set<string>();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = `${seg.platform}/${seg.actionId}`;
    const segErrors: string[] = [];

    // Access control
    if (!isActionAllowed(seg.actionId, actionIds)) {
      segErrors.push(`Action "${seg.actionId}" is not in the allowed action list`);
    }
    if (!connectionKeys.includes('*') && !connectionKeys.includes(seg.connectionKey)) {
      segErrors.push(`Connection key "${seg.connectionKey}" is not allowed`);
    }

    // Fetch action details (cache-served when fresh)
    let actionDetails: ActionDetails | undefined;
    let preflightCacheHit = false;
    try {
      const resolved = await resolveActionDetails(api, seg.actionId, {
        useCache: flags.useCache,
        warn: (msg) => {
          if (staleWarned.has(seg.actionId)) return;
          staleWarned.add(seg.actionId);
          process.stderr.write(msg);
        },
      });
      actionDetails = resolved.details;
      preflightCacheHit = resolved.cacheHit;
    } catch (err) {
      segErrors.push(`Action not found: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (actionDetails && !isMethodAllowed(actionDetails.method, permissions)) {
      segErrors.push(`Method "${actionDetails.method}" not allowed under "${permissions}" permission level`);
    }

    // Parse JSON args
    let data: unknown;
    let pathVariables: Record<string, unknown> | undefined;
    let queryParams: Record<string, unknown> | undefined;
    let headers: Record<string, string> | undefined;

    if (seg.data) {
      const r = tryParseJson(seg.data, `segment ${i + 1} --data`);
      if (r.error) segErrors.push(r.error); else data = r.value;
    }
    if (seg.pathVars) {
      const r = tryParseJson(seg.pathVars, `segment ${i + 1} --path-vars`);
      if (r.error) segErrors.push(r.error); else pathVariables = r.value as Record<string, unknown>;
    }
    if (seg.queryParams) {
      const r = tryParseJson(seg.queryParams, `segment ${i + 1} --query-params`);
      if (r.error) segErrors.push(r.error); else queryParams = r.value as Record<string, unknown>;
    }
    if (seg.headers) {
      const r = tryParseJson(seg.headers, `segment ${i + 1} --headers`);
      if (r.error) segErrors.push(r.error); else headers = r.value as Record<string, string>;
    }

    // Schema validation
    if (actionDetails && !flags.skipValidation && segErrors.length === 0) {
      const validation = validateActionInput(actionDetails, {
        data: data as Record<string, unknown> | undefined,
        pathVariables,
        queryParams,
      });
      if (!validation.valid) {
        for (const m of validation.missing) {
          segErrors.push(`Missing ${m.flag} "${m.param}"${m.description ? ` — ${m.description}` : ''}`);
        }
      }
    }

    if (segErrors.length > 0) {
      errors.push({ segment: i + 1, label, messages: segErrors });
    } else if (actionDetails) {
      prepared.push({ segment: seg, index: i, actionDetails, preflightCacheHit, data, pathVariables, queryParams, headers });
    }
  }

  if (errors.length > 0) {
    if (output.isAgentMode()) {
      output.json({ error: 'Validation failed', segments: errors });
      process.exit(1);
    }
    console.log();
    for (const e of errors) {
      console.log(`  ${pc.red('✗')} Segment ${e.segment} (${e.label}):`);
      for (const msg of e.messages) {
        console.log(`    ${msg}`);
      }
    }
    console.log();
    output.error(`Validation failed for ${errors.length} segment(s). Fix errors above before executing.`);
  }

  // ── Phase 3: execute ──

  const total = prepared.length;
  const overallStart = Date.now();
  const results: SegmentResult[] = [];

  for (let i = 0; i < total; i += flags.maxConcurrency) {
    const batch = prepared.slice(i, i + flags.maxConcurrency);
    const settled = await Promise.allSettled(
      batch.map(async (action): Promise<SegmentResult> => {
        const start = Date.now();
        const seg = action.segment;
        const segIdx = action.index + 1;

        // Mock mode
        if (flags.mock) {
          const mockResponse = action.actionDetails.ioSchema?.ioExample?.output ?? null;
          return {
            segment: segIdx,
            platform: seg.platform,
            actionId: seg.actionId,
            status: 'success',
            durationMs: Date.now() - start,
            mock: true,
            request: { method: action.actionDetails.method, url: action.actionDetails.path },
            response: mockResponse,
            _preflight: { cache: action.preflightCacheHit ? 'hit' : 'miss' },
          };
        }

        const result = await api.executePassthroughRequest({
          platform: seg.platform,
          actionId: seg.actionId,
          connectionKey: seg.connectionKey,
          data: action.data,
          pathVariables: action.pathVariables as Record<string, string | number | boolean> | undefined,
          queryParams: action.queryParams,
          headers: action.headers,
          isFormData: seg.formData,
          isFormUrlEncoded: seg.formUrlEncoded,
          dryRun: flags.dryRun,
        }, action.actionDetails);

        return {
          segment: segIdx,
          platform: seg.platform,
          actionId: seg.actionId,
          status: 'success',
          durationMs: Date.now() - start,
          dryRun: flags.dryRun || undefined,
          request: {
            method: result.requestConfig.method,
            url: result.requestConfig.url,
            ...(flags.dryRun ? { headers: result.requestConfig.headers, data: result.requestConfig.data } : {}),
          },
          response: flags.dryRun ? undefined : result.responseData,
          _preflight: { cache: action.preflightCacheHit ? 'hit' : 'miss' },
        };
      }),
    );

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        // Find the matching prepared action for this rejected promise
        const batchIdx = settled.indexOf(s);
        const action = batch[batchIdx];
        results.push({
          segment: action.index + 1,
          platform: action.segment.platform,
          actionId: action.segment.actionId,
          status: 'error',
          durationMs: 0,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
      }
    }
  }

  const totalDurationMs = Date.now() - overallStart;
  const succeeded = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'error').length;

  // ── Phase 4: output ──

  if (output.isAgentMode()) {
    output.json({
      parallel: true,
      totalDurationMs,
      succeeded,
      failed,
      results,
    });
    if (failed > 0) process.exit(1);
    return;
  }

  // Human mode
  console.log();
  for (const r of results) {
    const label = `${r.platform}/${r.actionId}`;
    const time = pc.dim(`(${(r.durationMs / 1000).toFixed(2)}s)`);
    if (r.mock) {
      console.log(`  [${r.segment}/${total}] ${label} ${pc.cyan('◇ mock')} ${time}`);
      if (r.response) console.log(`  ${pc.dim(JSON.stringify(r.response, null, 2).split('\n').join('\n  '))}`);
    } else if (r.dryRun) {
      console.log(`  [${r.segment}/${total}] ${label} ${pc.yellow('⊘ dry-run')} ${time}`);
    } else if (r.status === 'success') {
      console.log(`  [${r.segment}/${total}] ${label} ${pc.green('✓')} ${time}`);
      if (r.response) console.log(`  ${pc.dim(JSON.stringify(r.response, null, 2).split('\n').join('\n  '))}`);
    } else {
      console.log(`  [${r.segment}/${total}] ${label} ${pc.red('✗')} ${time} — ${r.error}`);
    }
  }
  console.log();

  const tag = flags.mock ? 'mock' : flags.dryRun ? 'dry-run' : undefined;
  if (tag) {
    console.log(`  Summary: ${total} ${tag} (${(totalDurationMs / 1000).toFixed(2)}s total)`);
  } else {
    console.log(`  Summary: ${succeeded} succeeded, ${failed} failed (${(totalDurationMs / 1000).toFixed(2)}s total)`);
  }
  console.log();
}

