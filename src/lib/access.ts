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
  ConnectionAccess,
  KeyAccessDocument,
  PermissionLevel,
  ResolvedAllowedAction,
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
    return { policy: 'methods', methods };
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
    return { access: { policy: 'methods', methods: envelope.methods.map(m => m.toUpperCase()) }, unresolved: [] };
  }
  return { access: { policy: 'full' }, unresolved: [] };
}

const READ_WRITE = ['GET', 'PATCH', 'POST', 'PUT'];

/** The consent page's name for an access: Full access, Read & write, Read only, Custom, No access. */
export function accessLevel(access: ConnectionAccess): AccessLevel {
  switch (access.policy) {
    case 'full':
      return 'full';
    case 'methods': {
      const set = [...new Set(access.methods.map(m => m.toUpperCase()))].sort();
      if (set.length === 0) return 'none';
      if (set.length === 1 && set[0] === 'GET') return 'read-only';
      if (set.join(',') === READ_WRITE.join(',')) return 'read-write';
      return 'custom';
    }
    case 'actions':
      return access.actions.length === 0 ? 'none' : 'custom';
  }
}

const LEVEL_LABELS: Record<AccessLevel, string> = {
  full: 'Full access',
  'read-write': 'Read & write',
  'read-only': 'Read only',
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
      return access.methods.join(', ');
    case 'actions': {
      if (access.actions.length === 0) return 'none';
      const shown = access.actions.slice(0, maxActions).map(a => `${a.title} (${a.method})`);
      const rest = access.actions.length - shown.length;
      return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
    }
  }
}
