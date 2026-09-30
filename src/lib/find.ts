/**
 * `one actions find` and `one actions load`: find the action for every
 * operation a task needs, across platforms, with its documentation, in one
 * call, and load more of any document.
 *
 * Core picks the actions (`POST /available-actions/find`: search plus One's
 * decision model). This module applies what only this CLI knows - its action
 * allowlist, permission level and connection scope - and documents each
 * action from its raw knowledge (through the action-details cache, which also
 * warms `actions execute`), so a digest's notes are the exact `actions load`
 * command. The answer follows the remote MCP's `find_one_actions`: the pick,
 * actions also chosen, a substitute set apart, and alternatives.
 *
 * Pure apart from the injected `FindDeps`, so it is tested without a network.
 */

import { isActionAllowed, isMethodAllowed } from './api.js';
import {
  buildDigest,
  collapseSections,
  flattenSections,
  parseSectionFlag,
  parseSections,
  renderDigestBanner,
  renderDigestNotice,
  selectSections,
} from './knowledge-sections.js';
import type { ActionDetails, FindIntent, FoundAction, FoundActions, PermissionLevel } from './types.js';

/** How many intents one find answers. Core enforces the same cap. */
export const FIND_MAX_INTENTS = 10;

/** How many documents one load returns. */
export const FIND_MAX_LOADS = 10;

/** Characters of documentation one answer carries in all, as core bounds its own (about 100k tokens). */
export const FIND_DOCUMENTS_BUDGET = 400_000;

/** What stands in for an action's documentation when it has none. */
export const NO_KNOWLEDGE = '(No additional knowledge available for this action.)';

/** One wording for an action that does not exist and one this CLI may not use, so neither can be told apart. */
export const REFUSED_LOAD = 'no such action, or this CLI may not use it';

/**
 * How to run what the documentation describes, stated once per answer rather
 * than once per action.
 */
export const EXECUTE_GUIDE = `Run an action with:
  one --agent actions execute <platform> <actionId> <connectionKey> [--path-vars '{...}'] [--query-params '{...}'] [-d '{...}']
Connection keys come from \`one --agent list\`. Put each value where the action's documentation says it goes: path variables (placeholders like {userId}) in --path-vars, query parameters in --query-params, the request body in -d. Never put path variables or query parameters in -d.`;

/** What find and load need from the One API. */
export interface FindDeps {
  findActions(requests: FindIntent[], task: string | undefined, knowledgeAgent: boolean): Promise<FoundActions[]>;
  /** An action's details, from the action-details cache when fresh. */
  getActionDetails(actionId: string): Promise<ActionDetails>;
  /** The platforms the configured connection keys reach; only asked when they are scoped. */
  connectedPlatforms(): Promise<string[]>;
}

/** This CLI's settings that shape an answer. */
export interface FindSettings {
  /** Knowledge-only mode: documents whole, with how to call each from code. */
  knowledgeAgent: boolean;
  permissions: PermissionLevel;
  /** `['*']` allows every action. */
  actionIds: string[];
  /** `['*']` reaches every platform. */
  connectionKeys: string[];
  /** The One API base including `/v1`, for the passthrough URL in knowledge mode. */
  apiBase: string;
}

/** A call that has to be fixed before it can be answered. */
export class FindArgsError extends Error {}

/** An action as the agent refers to it, without documentation. */
export interface ActionRef {
  actionId: string;
  title: string;
  method: string;
  path: string;
}

/** An action with its documentation, as an answer carries it. */
export interface DocumentedAction extends ActionRef {
  /** The digest, section, contents or whole document the agent reads. */
  knowledge: string;
  /** True when `knowledge` is not the whole document. */
  truncated: boolean;
}

/** One intent's answer. */
export interface FindAnswer extends FindIntent {
  /** Why the answer is what it is. */
  status: string;
  selector?: FoundActions['selector'];
  confidence?: number;
  /** The actions to use, documented. */
  selected: DocumentedAction[];
  /** Also to use, but listed rather than documented: load them. */
  alsoSelected: ActionRef[];
  /** A substitute for the pick: one or the other, never both. Documented unless listed. */
  runnerUp?: DocumentedAction | ActionRef;
  alternatives: ActionRef[];
}

export interface FindResult {
  answers: FindAnswer[];
  /** What applies to every documented action, stated once: how to execute, or the code guide's rules. */
  guide?: string;
}

/** One `actions load` entry's outcome. */
export type LoadedEntry = DocumentedAction | { actionId: string; error: string };

export interface LoadResult {
  loaded: LoadedEntry[];
  guide?: string;
}

/** What `actions load` asks of each document. */
export interface LoadOptions {
  section?: string | string[];
  full?: boolean;
  toc?: boolean;
}

/** An action as the agent refers to it: title, method, path and `actionId`. */
export function actionHeading(action: ActionRef): string {
  return `${action.title} · \`${action.method.toUpperCase()} ${action.path}\` · actionId: \`${action.actionId}\``;
}

const ref = (a: FoundAction): ActionRef => ({ actionId: a.systemId, title: a.title, method: a.method, path: a.path });

function allows(settings: FindSettings, action: { systemId: string; method: string }): boolean {
  return isActionAllowed(action.systemId, settings.actionIds) && isMethodAllowed(action.method, settings.permissions);
}

/** The platforms this CLI reaches, or `null` when every platform is. */
async function reachable(settings: FindSettings, deps: FindDeps): Promise<string[] | null> {
  if (settings.connectionKeys.includes('*')) return null;
  return (await deps.connectedPlatforms()).map((p) => p.toLowerCase());
}

interface Narrowed {
  answer: FoundActions;
  /** The pick was refused and another allowed candidate took its place. */
  replaced: boolean;
  /** The pick was refused and no allowed candidate could take its place. */
  pickRefused: boolean;
  /** Core found actions, but this CLI's settings refuse every one of them. */
  refusedAll: boolean;
}

/**
 * Drops every action this CLI's settings refuse. A refused pick is replaced
 * by the runner-up, else the first allowed alternative, even when a companion
 * survives, so a companion is never presented as the pick.
 */
function narrow(answer: FoundActions, settings: FindSettings): Narrowed {
  const allowed = (action: FoundAction) => allows(settings, action);
  const selected = answer.selected.filter(allowed);
  const alternatives = answer.alternatives.filter(allowed);
  let alsoSelected = (answer.alsoSelected ?? []).filter(allowed);
  let runnerUp = answer.runnerUp && allowed(answer.runnerUp) ? answer.runnerUp : undefined;
  let replaced = false;
  let pickRefused = false;

  if (answer.selected.length > 0 && !allowed(answer.selected[0])) {
    const next = runnerUp ?? alternatives.shift();
    if (next) {
      selected.unshift(next);
      runnerUp = next === runnerUp ? undefined : runnerUp;
      replaced = true;
    } else {
      // Nothing can stand in for the pick. What it needed beside it is still
      // listed, but never presented as the pick itself.
      alsoSelected = [...selected, ...alsoSelected];
      selected.length = 0;
      pickRefused = true;
    }
  }

  const found = answer.selected.length + answer.alternatives.length + (answer.alsoSelected?.length ?? 0) + (answer.runnerUp ? 1 : 0);
  const kept = selected.length + alternatives.length + alsoSelected.length + (runnerUp ? 1 : 0);

  return {
    answer: { ...answer, selected, alsoSelected, runnerUp, alternatives },
    replaced,
    pickRefused: pickRefused && kept > 0,
    refusedAll: found > 0 && kept === 0,
  };
}

/** Why the answer is what it is, as its opening line. Worded as the remote MCP's. */
function status(answer: FoundActions, narrowed: Pick<Narrowed, 'replaced' | 'pickRefused' | 'refusedAll'>): string {
  if (narrowed.pickRefused) {
    return 'The chosen action is not allowed by this CLI, and no allowed candidate can take its place. The actions listed were needed beside it; tell the user which operation is blocked.';
  }
  if (narrowed.refusedAll) {
    return "Actions were found for this intent, but this CLI's access settings (action allowlist, permission level) allow none of them, so rephrasing will not help. Tell the user which operation is blocked.";
  }
  if (narrowed.replaced) {
    return 'The chosen action is not allowed by this CLI, so this is the next allowed candidate: check it fits before using it.';
  }
  if (answer.selector === 'none_fit' || answer.selected.length === 0) {
    return answer.alternatives.length === 0
      ? 'No action fits this intent, and nothing close was found. Rephrase it, or check the platform name.'
      : 'No action fits this intent. Rephrase it more specifically, or load one of the alternatives.';
  }
  if (answer.selector === 'search_order') {
    return 'The decision model was unavailable, so this is the top search result: check it fits before using it.';
  }
  return answer.confidence === undefined ? 'Chosen by the decision model.' : `Chosen with confidence ${answer.confidence.toFixed(2)}.`;
}

/**
 * An action's documentation: a digest whose notes are the exact `actions
 * load` command, or the whole document with how to call it from code in
 * knowledge mode.
 */
function document(action: ActionRef, details: ActionDetails | Error, platform: string, settings: FindSettings): DocumentedAction {
  if (details instanceof Error) {
    return {
      ...action,
      knowledge: `Its documentation could not be loaded (${details.message}). Load it with \`one --agent actions load ${action.actionId}\` before executing it; never execute it without reading it.`,
      truncated: true,
    };
  }
  const knowledge = details.knowledge;
  if (settings.knowledgeAgent) {
    return { ...action, knowledge: codeGuideAction(action, knowledge, platform, details.tags ?? [], settings.apiBase), truncated: false };
  }
  if (!knowledge) {
    return { ...action, knowledge: NO_KNOWLEDGE, truncated: false };
  }
  const doc = parseSections(knowledge);
  const digest = buildDigest(doc, { actionId: action.actionId });
  if (!digest.truncated || doc.sections.length === 0) {
    return { ...action, knowledge, truncated: false };
  }
  return {
    ...action,
    knowledge: [renderDigestBanner(digest), digest.markdown, renderDigestNotice(digest, action.actionId)].filter(Boolean).join('\n\n'),
    truncated: true,
  };
}

/**
 * Answers `actions find`: the action for every intent, narrowed and
 * documented. `knowledgeCatalog` searches the catalog for writing code and
 * building flows - the platform's own endpoints, which executing agents are
 * steered away from - rather than the one for executing actions; knowledge-only
 * mode always does.
 */
export async function find(
  requests: FindIntent[],
  task: string | undefined,
  deps: FindDeps,
  settings: FindSettings,
  knowledgeCatalog = false
): Promise<FindResult> {
  if (requests.length === 0 || requests.length > FIND_MAX_INTENTS) {
    throw new FindArgsError(`Send between 1 and ${FIND_MAX_INTENTS} platform and intent pairs.`);
  }
  const empty = requests.find((r) => !r.platform.trim() || !r.intent.trim());
  if (empty) {
    throw new FindArgsError('Every request needs a platform and an intent.');
  }

  const platforms = await reachable(settings, deps);
  const reaches = (platform: string) => platforms === null || platforms.includes(platform.toLowerCase());
  const asked = requests.filter((r) => reaches(r.platform));
  const answers =
    asked.length > 0 ? await deps.findActions(asked, task, settings.knowledgeAgent || knowledgeCatalog) : [];
  // Answers pair with requests by position, so a short or malformed reply
  // must fail as itself rather than as a read of a missing answer.
  if (answers.length !== asked.length) {
    throw new Error(`One answered ${answers.length} of ${asked.length} requests; try again.`);
  }
  let next = 0;

  const plans = requests.map((intent) => {
    if (!reaches(intent.platform)) return { intent, unreachable: true as const };
    const narrowed = narrow(answers[next++], settings);
    const { answer } = narrowed;
    // Whole documents are large, so knowledge mode documents the pick alone.
    const picks = settings.knowledgeAgent ? answer.selected.slice(0, 1) : answer.selected;
    return {
      intent,
      unreachable: false as const,
      narrowed,
      picks,
      deferred: [...answer.selected.slice(picks.length), ...(answer.alsoSelected ?? [])],
      runnerUpDocumented: !settings.knowledgeAgent && answer.runnerUp !== undefined,
    };
  });

  const ids = new Set<string>();
  for (const plan of plans) {
    if (plan.unreachable) continue;
    plan.picks.forEach((a) => ids.add(a.systemId));
    if (plan.runnerUpDocumented && plan.narrowed.answer.runnerUp) ids.add(plan.narrowed.answer.runnerUp.systemId);
  }
  const details = new Map<string, ActionDetails | Error>(
    await Promise.all(
      [...ids].map(async (id) => {
        try {
          return [id, await deps.getActionDetails(id)] as const;
        } catch (error) {
          return [id, error instanceof Error ? error : new Error(String(error))] as const;
        }
      })
    )
  );

  // Bounded as a whole, picks before any runner-up. The first document is
  // always served; past the budget an intent stops at its first pick that
  // does not fit and lists it and the rest to load, rather than documenting a
  // smaller one in its place.
  let used = 0;
  let served = false;
  const admit = (doc: DocumentedAction) => {
    if (served && used + doc.knowledge.length > FIND_DOCUMENTS_BUDGET) return false;
    used += doc.knowledge.length;
    served = true;
    return true;
  };

  const result: FindAnswer[] = plans.map((plan) => {
    if (plan.unreachable) {
      return {
        ...plan.intent,
        status: `Platform "${plan.intent.platform}" has no allowed connections for this CLI.`,
        selected: [],
        alsoSelected: [],
        alternatives: [],
      };
    }
    const { answer } = plan.narrowed;
    const selected: DocumentedAction[] = [];
    const deferred: ActionRef[] = [];
    for (const [index, pick] of plan.picks.entries()) {
      const doc = document(ref(pick), details.get(pick.systemId) ?? new Error('not fetched'), plan.intent.platform, settings);
      if (!admit(doc)) {
        deferred.push(...plan.picks.slice(index).map(ref));
        break;
      }
      selected.push(doc);
    }
    return {
      ...plan.intent,
      status: status(answer, plan.narrowed),
      selector: answer.selector,
      ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
      selected,
      alsoSelected: [...deferred, ...plan.deferred.map(ref)],
      ...(answer.runnerUp ? { runnerUp: ref(answer.runnerUp) } : {}),
      alternatives: answer.alternatives.map(ref),
    };
  });

  plans.forEach((plan, index) => {
    if (plan.unreachable || !plan.runnerUpDocumented || !plan.narrowed.answer.runnerUp) return;
    const runnerUp = plan.narrowed.answer.runnerUp;
    const doc = document(ref(runnerUp), details.get(runnerUp.systemId) ?? new Error('not fetched'), plan.intent.platform, settings);
    if (used + doc.knowledge.length <= FIND_DOCUMENTS_BUDGET) {
      used += doc.knowledge.length;
      result[index].runnerUp = doc;
    }
  });

  const documented = result.some((a) => a.selected.length > 0 || (a.runnerUp && 'knowledge' in a.runnerUp));
  return { answers: result, ...(documented ? { guide: closingGuide(settings) } : {}) };
}

/** Answers `actions load`: more of each named action's documentation. */
export async function load(
  actionIds: string[],
  options: LoadOptions,
  deps: FindDeps,
  settings: FindSettings
): Promise<LoadResult> {
  if (actionIds.length === 0 || actionIds.length > FIND_MAX_LOADS) {
    throw new FindArgsError(`Load between 1 and ${FIND_MAX_LOADS} actions at once.`);
  }

  const platforms = await reachable(settings, deps);
  const entries = await Promise.all(
    actionIds.map(async (actionId): Promise<LoadedEntry> => {
      const refused = { actionId, error: REFUSED_LOAD };
      if (!isActionAllowed(actionId, settings.actionIds)) return refused;
      const details = await deps.getActionDetails(actionId).catch(() => undefined);
      if (!details || !isMethodAllowed(details.method, settings.permissions)) return refused;
      // Scope can only be checked against a platform the action names. One
      // without it is catalog documentation, not a connection's data, so it
      // is served rather than refused.
      const platform = details.connectionPlatform ?? '';
      if (platforms !== null && platform && !platforms.includes(platform.toLowerCase())) return refused;
      const action: ActionRef = { actionId, title: details.title, method: details.method, path: details.path };
      if (settings.knowledgeAgent) {
        return document(action, details, platform, settings);
      }
      return { ...action, ...part(details.knowledge, actionId, options) };
    })
  );

  let used = 0;
  let served = false;
  const loaded = entries.map((entry): LoadedEntry => {
    if ('error' in entry) return entry;
    if (served && used + entry.knowledge.length > FIND_DOCUMENTS_BUDGET) {
      return { actionId: entry.actionId, error: 'too large to serve beside the others; load it on its own' };
    }
    used += entry.knowledge.length;
    served = true;
    return entry;
  });

  const documented = loaded.some((e) => !('error' in e));
  return { loaded, ...(documented ? { guide: closingGuide(settings) } : {}) };
}

/**
 * The part of a document a load asked for: named sections, the table of
 * contents, the whole document, or the digest. Named sections win over the
 * contents, which win over the whole document; `--section all` is the whole.
 */
function part(knowledge: string | undefined, actionId: string, options: LoadOptions): { knowledge: string; truncated: boolean } {
  if (!knowledge) return { knowledge: NO_KNOWLEDGE, truncated: false };
  const doc = parseSections(knowledge);
  const names = parseSectionFlag(options.section);
  const specific = names.filter((n) => n.toLowerCase() !== 'all');

  if (specific.length > 0) {
    const picked = selectSections(doc, specific);
    if (!picked.ok) {
      const toc = collapseSections(picked.candidates);
      const listing = toc.sections
        .map((c) => `${c.heading} [${c.id}] (${c.chars} chars${c.children ? `, +${c.children} nested` : ''})`)
        .join('\n');
      const lead =
        picked.reason === 'ambiguous'
          ? `Section "${picked.query}" matches several sections; pick one by id or full heading.`
          : `No section named "${picked.query}". Use one of the names below, or --full.`;
      return { knowledge: `${lead}\n\n${listing}`, truncated: true };
    }
    return { knowledge: picked.markdown, truncated: true };
  }
  if (options.toc) {
    const listing = flattenSections(doc.sections)
      .map((s) => `${'  '.repeat(Math.max(0, s.level - 1))}${s.heading} [${s.id}] (${s.chars} chars)`)
      .join('\n');
    return {
      knowledge: `Table of contents. Load any with: one --agent actions load ${actionId} --section "<id or heading>", or the whole document with --full.\n\n${listing || '(this document has no sections)'}`,
      truncated: true,
    };
  }
  if (options.full === true || names.length > 0) {
    return { knowledge, truncated: false };
  }
  const digest = buildDigest(doc, { actionId });
  if (!digest.truncated || doc.sections.length === 0) return { knowledge, truncated: false };
  return {
    knowledge: [renderDigestBanner(digest), digest.markdown, renderDigestNotice(digest, actionId)].filter(Boolean).join('\n\n'),
    truncated: true,
  };
}

function closingGuide(settings: FindSettings): string {
  return settings.knowledgeAgent ? codeGuideRules() : EXECUTE_GUIDE;
}

/**
 * Uppercases a platform id into an env-var segment, collapsing every
 * non-alphanumeric run to a single underscore (`ship-station` → `SHIP_STATION`).
 */
function platformEnvSegment(platform: string): string {
  const segment = platform
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .join('_');
  return segment || 'PLATFORM';
}

const CUSTOM_ACTION_NOTE =
  '\n\nThis is a custom action: ALSO include "connectionKey" (the same value as the x-one-connection-key header) as a field in the JSON body for non-GET requests.';

/**
 * One action for knowledge mode: its whole document under its heading, then
 * how to call it through the One Passthrough API. Worded as the remote MCP's
 * `code_guide_action`; {@link codeGuideRules} holds what every action shares.
 */
export function codeGuideAction(
  action: ActionRef,
  knowledge: string | undefined,
  platform: string,
  tags: string[],
  apiBase: string
): string {
  const base = apiBase.replace(/\/$/, '');
  const method = action.method.toUpperCase();
  const path = action.path.startsWith('/') ? action.path : `/${action.path}`;
  const connEnv = `ONE_${platformEnvSegment(platform)}_CONNECTION_KEY`;
  const customNote = tags.includes('custom') ? CUSTOM_ACTION_NOTE : '';

  return `### ${actionHeading(action)}
**Platform:** ${platform}

${knowledge ?? NO_KNOWLEDGE}

## Calling this action from code
URL:    ${base}/passthrough${path}
Method: ${method}
Headers:
- x-one-secret: the value of the ONE_SECRET env var
- x-one-connection-key: the value of the ${connEnv} env var
- x-one-action-id: ${action.actionId}
- Content-Type: application/json${customNote}

Environment variables: ONE_SECRET (their One API key) and ${connEnv} (the key of their ${platform} connection), both from the One dashboard.

\`\`\`typescript
const response = await fetch("${base}/passthrough${path}", {
method: "${method}",
headers: {
"x-one-secret": process.env.ONE_SECRET,
"x-one-connection-key": process.env.${connEnv},
"x-one-action-id": "${action.actionId}",
"Content-Type": "application/json",
},
// body: JSON.stringify(...) - only for non-GET requests
});
\`\`\``;
}

/** The Integration Code Guide's rules, which hold for every action. Worded as the remote MCP's `code_guide_rules`. */
export function codeGuideRules(): string {
  return `================================================================
INTEGRATION CODE GUIDE - using these actions in an application
================================================================
You are in knowledge mode: actions cannot be executed here. Use this
guide, with each action's "Calling this action from code", to write
integration code in the user's project.

## 1. Where this code must live
Server-side only - an API route, edge function, or backend handler
(e.g. Supabase Edge Function, Next.js route handler, Express route).
NEVER call this API from browser/client code and NEVER hardcode secret
values in source - read them from environment variables.

## 2. The request
All calls go through the One Passthrough API. Do NOT call the third-party
API URL from the documentation directly. The URL is the One base plus the
action path ONLY:
✅ {One base}/v1/passthrough{action path}   (the path starts with /)
❌ {One base}/v1/passthrough/https://some-vendor-api.com{action path}

## 3. Parameter placement
Per each action's documentation:
- Path variables (placeholders like {{userId}} in the path) → substitute
  real values into the URL path; never send them in the body.
- Query parameters → the URL query string, not the body.
- Body fields → the JSON request body (POST/PUT/PATCH only).

## 4. Environment variables & deployment
The code will not work until the user sets each action's environment
variables in their hosting platform's secrets manager (Supabase secrets,
Vercel/Netlify environment settings, or the project's env settings -
never committed to code). When you deliver the code, explicitly tell the
user to set them.

## 5. Code generation rules
- Use TypeScript unless the user asked for another language.
- Include the complete input/output structure from the documentation
  (required/optional fields, types) in the implementation.
- Handle errors: on a non-2xx response, read the response body and
  surface a useful message.`;
}

/** The answer as text, in the remote MCP's layout, for a person at a terminal. */
export function renderFind(result: FindResult): string {
  const listing = (lead: string, actions: ActionRef[]) =>
    actions.length === 0
      ? []
      : [`${lead} (load with \`one actions load <actionId>\`):\n${actions.map((a) => `- ${actionHeading(a)}`).join('\n')}`];
  const shown = (doc: DocumentedAction) =>
    doc.knowledge.startsWith('### ') ? doc.knowledge : `### ${actionHeading(doc)}\n\n${doc.knowledge}`;

  const sections = result.answers.map((answer) => {
    const parts = [`## ${answer.platform}: ${answer.intent}\n\n${answer.status}`];
    parts.push(...answer.selected.map(shown));
    parts.push(
      ...listing(
        answer.selected.length === 0
          ? 'Chosen for this intent, documentation left out to keep the answer small'
          : 'Also chosen for this intent, documentation left out to keep the answer small',
        answer.alsoSelected
      )
    );
    if (answer.runnerUp) {
      const lead = 'If the chosen action does not fit, use this one instead: one or the other, never both';
      parts.push(...('knowledge' in answer.runnerUp ? [`${lead}.\n\n${shown(answer.runnerUp)}`] : listing(lead, [answer.runnerUp])));
    }
    parts.push(...listing('Alternatives, not documented', answer.alternatives));
    return parts.join('\n\n');
  });

  return [...sections, ...(result.guide ? [result.guide] : [])].join('\n\n---\n\n');
}

/** The loaded documents as text, for a person at a terminal. */
export function renderLoad(result: LoadResult): string {
  const entries = result.loaded.map((entry) =>
    'error' in entry
      ? `\`${entry.actionId}\`: ${entry.error}`
      : entry.knowledge.startsWith('### ')
        ? entry.knowledge
        : `### ${actionHeading(entry)}\n\n${entry.knowledge}`
  );
  return [...entries, ...(result.guide ? [result.guide] : [])].join('\n\n---\n\n');
}
