/**
 * Access resolution — turning the configured access control (permission level,
 * connection scope, action allowlist) into a concrete answer to "what can I run
 * on this connection?".
 *
 * `one list` reports this per connection so an agent knows its reach up front,
 * instead of discovering it as a 403 halfway through a workflow. The shapes
 * mirror the One MCP server's `list_one_integrations` `access` field, so an
 * agent that has learned one surface already understands the other.
 *
 * Precedence (same as the MCP server and One core):
 *   action allowlist  >  permission level  >  full access
 */

import type { OneApi } from './api.js';
import { PERMISSION_METHODS } from './api.js';
import { resolveActionDetails } from './action-details.js';
import type {
  AccessLevel,
  ActionLevel,
  ConnectionAccess,
  KeyAccessDocument,
  KeyAccessRule,
  PermissionLevel,
  ReachableConnection,
  ResolvedAllowedAction,
  ViewerAccessLevel,
} from './types.js';

/**
 * Resolves an allowlist of action ids to their metadata (title, method, and
 * owning platform), so each connection can report the exact actions it may run.
 *
 * `['*']` (unrestricted) resolves to an empty list — there is no allowlist to
 * enumerate, and no network call is made. Ids that fail to resolve, or that
 * carry no platform, are skipped rather than failing the whole listing; the
 * caller reports them separately so nothing is dropped silently.
 *
 * Resolution goes through the knowledge cache, so a scoped config pays the
 * lookup once and reads from disk afterwards.
 */
export async function resolveAllowedActions(
  api: Pick<OneApi, 'getActionDetailsWithMeta'>,
  actionIds: string[]
): Promise<ResolvedAllowedAction[]> {
  if (actionIds.includes('*')) return [];

  const resolved = await Promise.all(
    actionIds.map(async (actionId): Promise<ResolvedAllowedAction | null> => {
      try {
        // Silence the stale-cache warning: a listing shouldn't print a network
        // notice per allowlisted action.
        const { details } = await resolveActionDetails(api, actionId, { warn: () => {} });
        if (!details.connectionPlatform) return null;
        return {
          actionId,
          title: details.title,
          method: details.method,
          platform: details.connectionPlatform,
        };
      } catch {
        return null;
      }
    })
  );

  return resolved.filter((a): a is ResolvedAllowedAction => a !== null);
}

/**
 * What the current access config lets you run on a connection of `platform`.
 *
 * `grantedActions` is the allowlist already resolved by `resolveAllowedActions`
 * and filtered by the permission level — pass `[]` when the allowlist is `['*']`.
 */
export function computeConnectionAccess(
  platform: string,
  permissions: PermissionLevel,
  allowedActionIds: string[],
  grantedActions: ResolvedAllowedAction[]
): ConnectionAccess {
  if (!allowedActionIds.includes('*')) {
    const actions = grantedActions
      .filter(a => a.platform === platform)
      .map(({ actionId, title, method }) => ({ actionId, title, method }));
    return { policy: 'actions', actions };
  }

  const methods = PERMISSION_METHODS[permissions];
  if (methods !== null) {
    return methodsAccess(methods);
  }

  return { policy: 'full' };
}

// ── The key's access as One enforces it ───────────────────────────────

/**
 * What one connection allows: `null` is unrestricted on that axis, `[]`
 * allows nothing. `reachable: false` means the key names no rule for it.
 */
export interface AccessEnvelope {
  reachable: boolean;
  methods: string[] | null;
  actionIds: string[] | null;
}

const UNRESTRICTED: AccessEnvelope = { reachable: true, methods: null, actionIds: null };
const UNREACHABLE: AccessEnvelope = { reachable: false, methods: [], actionIds: [] };

/**
 * What the server lets this key do on one connection, read off
 * `GET /v1/access/me` exactly as One's checker reads the same row:
 * - no document: unrestricted;
 * - `rules: null`: every connection, bounded by the top-level `methods`;
 * - `rules: [...]`: only the connections named; a rule's own `methods`
 *   wins over the top-level ones, and `actionIds` narrows to those actions;
 * - `rules: []`: no connection.
 */
export function serverEnvelope(doc: KeyAccessDocument | null, connectionKey: string): AccessEnvelope {
  if (!doc) return UNRESTRICTED;
  if (doc.rules === null) return { reachable: true, methods: doc.methods, actionIds: null };
  const rule = doc.rules.find(r => r.connectionKey === connectionKey);
  if (!rule) return UNREACHABLE;
  return {
    reachable: true,
    methods: rule.methods ?? doc.methods,
    actionIds: rule.actionIds ?? null,
  };
}

/**
 * A Connect grant's access as the document `serverEnvelope` reads: one rule
 * per connection the grant reaches, so a connection it doesn't reach is
 * unreachable.
 */
export function grantAccessDocument(reachable: ReachableConnection[]): KeyAccessDocument {
  return {
    methods: null,
    rules: reachable.map(({ key, access }): KeyAccessRule => {
      const rule: KeyAccessRule = { type: 'connection', connectionKey: key };
      if (access.policy === 'methods') rule.methods = access.methods;
      if (access.policy === 'actions') rule.actionIds = access.actions.map(a => a.actionId);
      return rule;
    }),
  };
}

/** What the CLI's own access settings (`one config`) allow on one connection. */
export function localEnvelope(
  permissions: PermissionLevel,
  actionIds: string[],
  connectionKeys: string[],
  connectionKey: string
): AccessEnvelope {
  if (!connectionKeys.includes('*') && !connectionKeys.includes(connectionKey)) return UNREACHABLE;
  return {
    reachable: true,
    methods: PERMISSION_METHODS[permissions],
    actionIds: actionIds.includes('*') ? null : actionIds,
  };
}

function intersectList(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  const upper = new Set(b.map(x => x.toUpperCase()));
  return a.filter(x => upper.has(x.toUpperCase()));
}

/** Both must allow it: the server enforces one, the CLI the other. */
export function intersectEnvelopes(a: AccessEnvelope, b: AccessEnvelope): AccessEnvelope {
  if (!a.reachable || !b.reachable) return UNREACHABLE;
  return {
    reachable: true,
    methods: intersectList(a.methods, b.methods),
    actionIds: a.actionIds === null ? b.actionIds : b.actionIds === null ? a.actionIds : a.actionIds.filter(id => b.actionIds!.includes(id)),
  };
}

/**
 * The listing shape (mirrors the MCP server's `access`) for one envelope.
 * Action ids resolve through `resolved`; ids it could not resolve are still
 * returned in `unresolved` so nothing is dropped silently. An action list is
 * not re-filtered by the server's methods: the server checks each action's
 * semantic method, which its HTTP method does not always match. Only the
 * CLI's own limit (`localMethods`), which the CLI itself checks by HTTP
 * method, filters it.
 */
export function envelopeToAccess(
  envelope: AccessEnvelope,
  resolved: ResolvedAllowedAction[],
  /** The CLI's own method limit, which it checks against the HTTP method. */
  localMethods: string[] | null = null
): { access: ConnectionAccess; unresolved: string[] } {
  if (!envelope.reachable || (envelope.methods !== null && envelope.methods.length === 0)) {
    return { access: { policy: 'actions', actions: [] }, unresolved: [] };
  }
  if (envelope.actionIds !== null) {
    const actions = envelope.actionIds.flatMap(id => {
      const hit = resolved.find(a => a.actionId === id);
      if (!hit) return [];
      if (localMethods && !localMethods.includes(hit.method.toUpperCase())) return [];
      return [{ actionId: hit.actionId, title: hit.title, method: hit.method }];
    });
    return {
      access: { policy: 'actions', actions },
      unresolved: envelope.actionIds.filter(id => !resolved.some(a => a.actionId === id)),
    };
  }
  if (envelope.methods !== null) {
    return { access: methodsAccess(envelope.methods.map(m => m.toUpperCase())), unresolved: [] };
  }
  return { access: { policy: 'full' }, unresolved: [] };
}

const ACTION_LEVELS: ActionLevel[] = ['read', 'write', 'delete'];

/** The level One reads a method as; HEAD and the like stand for none. */
function levelOfMethod(method: string): ActionLevel | null {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'read';
    case 'POST':
    case 'PUT':
    case 'PATCH':
      return 'write';
    case 'DELETE':
      return 'delete';
    default:
      return null;
  }
}

/** A method-scoped access, with the levels its methods stand for. */
function methodsAccess(methods: string[]): ConnectionAccess {
  const levels = new Set(methods.map(levelOfMethod));
  return { policy: 'methods', methods, access: ACTION_LEVELS.filter(l => levels.has(l)) };
}

/** The name for a set of levels; a set no name covers is custom. */
function levelOfSet(levels: Set<ActionLevel>): AccessLevel {
  const key = ACTION_LEVELS.filter(l => levels.has(l)).join(',');
  switch (key) {
    case '':
      return 'none';
    case 'read':
      return 'read-only';
    case 'write':
      return 'write-only';
    case 'read,write':
      return 'read-write';
    case 'read,write,delete':
      return 'full';
    default:
      return 'custom';
  }
}

/** The consent page's name for an access, judged by level as One judges it. */
export function accessLevel(access: ConnectionAccess): AccessLevel {
  switch (access.policy) {
    case 'full':
      return 'full';
    case 'methods':
      return levelOfSet(new Set(access.methods.map(levelOfMethod).filter((l): l is ActionLevel => l !== null)));
    case 'actions':
      return access.actions.length === 0 ? 'none' : 'custom';
  }
}

const VIEWER_LEVELS: Record<ViewerAccessLevel, ActionLevel[] | null> = {
  none: [],
  read: ['read'],
  write: ['write'],
  read_write: ['read', 'write'],
  full: ['read', 'write', 'delete'],
  custom: null,
};

/**
 * What a call through the connection may really do: the key's access held to
 * the person's own level, as One holds it. An action list, or a custom share,
 * names actions a level cannot, so either stays custom unless the other is none.
 */
export function heldLevel(access: ConnectionAccess, viewer: ViewerAccessLevel | undefined): AccessLevel {
  const own = accessLevel(access);
  if (!viewer || viewer === 'full' || own === 'none') return own;
  const allowed = VIEWER_LEVELS[viewer];
  if (allowed?.length === 0) return 'none';
  if (allowed === null || access.policy === 'actions') return 'custom';
  const keyLevels = access.policy === 'full' ? ACTION_LEVELS : access.access;
  return levelOfSet(new Set(keyLevels.filter(l => allowed.includes(l))));
}

const VIEWER_LABELS: Record<ViewerAccessLevel, string> = {
  none: 'No access',
  read: 'Read only',
  write: 'Write only',
  read_write: 'Read & write',
  full: 'Full access',
  custom: 'Custom',
};

/** The dashboard's name for a person's own level on a connection. */
export function viewerLevelLabel(level: ViewerAccessLevel): string {
  return VIEWER_LABELS[level];
}

const LEVEL_LABELS: Record<AccessLevel, string> = {
  full: 'Full access',
  'read-write': 'Read & write',
  'read-only': 'Read only',
  'write-only': 'Write only',
  custom: 'Custom',
  none: 'No access',
};

export function accessLevelLabel(level: AccessLevel): string {
  return LEVEL_LABELS[level];
}

/**
 * One-line rendering of a connection's access for the human-readable table.
 * Action lists are truncated — the full list is in `--agent` output.
 */
export function formatAccess(access: ConnectionAccess, maxActions = 2): string {
  const level = accessLevel(access);
  if (level !== 'custom') return LEVEL_LABELS[level];
  switch (access.policy) {
    case 'full':
      return LEVEL_LABELS.full;
    case 'methods':
      return access.access.map(l => l[0].toUpperCase() + l.slice(1)).join(', ');
    case 'actions': {
      if (access.actions.length === 0) return 'none';
      const shown = access.actions.slice(0, maxActions).map(a => `${a.title} (${a.method})`);
      const rest = access.actions.length - shown.length;
      return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
    }
  }
}
