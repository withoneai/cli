/**
 * Access resolution — turning the key's rules on One, narrowed by the local
 * access config (permission level, action allowlist), into a concrete answer
 * to "what can I run on this connection?".
 *
 * `one list` reports this per connection so an agent knows its reach up front,
 * instead of discovering it as a 403 halfway through a workflow. The shapes
 * mirror the One MCP server's `list_one_integrations` `access` field, so an
 * agent that has learned one surface already understands the other.
 *
 * The key's rules are read live from `GET /v1/access/self` on every listing,
 * because they can be edited on the dashboard at any time. That route resolves
 * the calling key in its own tenancy, so the CLI never needs the key's id or
 * scope. The rules are matched the way One enforces them
 * (`EventAccessConnection::is_allowed`):
 *   - no rules         → only the key's global `methods` bound it
 *   - rules            → a connection no rule names is unreachable; a rule's own
 *                        `methods` override the global ones, and its
 *                        `actionIds` narrow it to those actions
 *   - methods          → judged against an action's CRUD verb (`envelopeMethod`)
 * The local config is the CLI's own extra restriction on top, never a widening.
 */

import type { OneApi } from './api.js';
import { PERMISSION_METHODS, isMethodAllowed } from './api.js';
import { resolveActionDetails } from './action-details.js';
import type {
  Connection,
  ConnectionAccess,
  KeyAccess,
  KeyAccessRule,
  PermissionLevel,
  ResolvedAllowedAction,
} from './types.js';

/**
 * What a key's rules on One allow on one connection; a `null` field is
 * unbounded. Where an envelope is optional, `null` means the key has rules
 * and none names the connection, so it reaches nothing there.
 */
export interface AccessEnvelope {
  methods: string[] | null;
  actionIds: string[] | null;
}

/** The envelope of a key with no restrictions on One. */
export const UNRESTRICTED: AccessEnvelope = { methods: null, actionIds: null };

/**
 * Every method One judges an action by (`CrudAction::semantic_method`). A
 * method list covering all of them bounds nothing, which is how the dashboard
 * stores "Full access" on a rule (every HTTP method, listed).
 */
const CRUD_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

function boundingMethods(methods: string[] | null): string[] | null {
  return methods !== null && CRUD_METHODS.every(m => methods.includes(m)) ? null : methods;
}

/**
 * Resolves action ids to their metadata (title, method, CRUD verb, and owning
 * platform), so each connection can report the exact actions it may run.
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
    [...new Set(actionIds)].map(async (actionId): Promise<ResolvedAllowedAction | null> => {
      try {
        // Silence the stale-cache warning: a listing shouldn't print a network
        // notice per allowlisted action.
        let { details } = await resolveActionDetails(api, actionId, { warn: () => {} });
        // A cache entry older than `envelopeMethod` would judge the action by
        // its HTTP method; refetch rather than guess its CRUD verb, keeping the
        // cached entry when the refetch fails (offline).
        if (details.envelopeMethod === undefined) {
          details = await resolveActionDetails(api, actionId, { useCache: false, warn: () => {} })
            .then(fresh => fresh.details)
            .catch(() => details);
        }
        if (!details.connectionPlatform) return null;
        return {
          actionId,
          title: details.title,
          method: details.method,
          envelopeMethod: (details.envelopeMethod ?? details.method).toUpperCase(),
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
 * Reads the `/access` route's body. `null` is the only "no restrictions"
 * answer; any other body that does not carry both `methods` and `rules` is an
 * error, so a malformed response can never be read as an unrestricted key.
 */
export function parseKeyAccess(body: unknown): KeyAccess | null {
  if (body === null) return null;
  if (typeof body !== 'object' || !('methods' in body) || !('rules' in body)) {
    throw new Error('unexpected response from the access route');
  }

  const { methods, rules } = body as { methods: unknown; rules: unknown };
  if (!isOptionalStrings(methods) || !(rules === null || (Array.isArray(rules) && rules.every(isKeyAccessRule)))) {
    throw new Error('unexpected access rules from the access route');
  }
  return { methods: methods ?? null, rules: rules ?? null };
}

function isOptionalStrings(value: unknown): value is string[] | null | undefined {
  return value == null || (Array.isArray(value) && value.every(v => typeof v === 'string'));
}

function isKeyAccessRule(rule: unknown): rule is KeyAccessRule {
  if (typeof rule !== 'object' || rule === null) return false;
  const r = rule as Record<string, unknown>;
  return (
    r.type === 'connection' &&
    typeof r.connectionKey === 'string' &&
    isOptionalStrings(r.methods) &&
    isOptionalStrings(r.actionIds)
  );
}

/** Every action id the key's rules name, so they can be resolved in one pass. */
export function keyAccessActionIds(access: KeyAccess | null): string[] {
  return (access?.rules ?? []).flatMap(rule => rule.actionIds ?? []);
}

/**
 * What the key's rules on One allow on `connection`, matched the way One's
 * `EventAccessConnection::is_allowed` matches them. `access: null` means the
 * key carries no restrictions.
 */
export function serverEnvelope(
  access: KeyAccess | null,
  connection: Pick<Connection, 'key'>
): AccessEnvelope | null {
  if (!access) return UNRESTRICTED;
  if (access.rules === null) return { methods: boundingMethods(access.methods), actionIds: null };

  const rule = access.rules.find(r => r.connectionKey === connection.key);
  if (!rule) return null;

  return { methods: boundingMethods(rule.methods ?? access.methods), actionIds: rule.actionIds ?? null };
}

/**
 * What the key may run on a connection of `platform`: the key's rules on One
 * (`envelope`), narrowed by the local permission level and action allowlist.
 *
 * `resolved` holds every action id either side names, already resolved by
 * `resolveAllowedActions`. With an `UNRESTRICTED` envelope this is exactly the
 * local-config answer.
 */
export function computeConnectionAccess(opts: {
  platform: string;
  envelope: AccessEnvelope | null;
  permissions: PermissionLevel;
  localActionIds: string[];
  resolved: ResolvedAllowedAction[];
}): ConnectionAccess {
  const { platform, envelope, permissions, localActionIds, resolved } = opts;
  if (envelope === null) return { policy: 'actions', actions: [] };

  const localAllowlist = localActionIds.includes('*') ? null : localActionIds;

  if (envelope.actionIds !== null || localAllowlist !== null) {
    const serverIds = envelope.actionIds;
    const actions = resolved
      .filter(a => a.platform === platform)
      .filter(a => serverIds === null || serverIds.includes(a.actionId))
      .filter(a => localAllowlist === null || localAllowlist.includes(a.actionId))
      .filter(a => envelope.methods === null || envelope.methods.includes(a.envelopeMethod))
      .filter(a => isMethodAllowed(a.method, permissions))
      .map(({ actionId, title, method }) => ({ actionId, title, method }));
    return { policy: 'actions', actions };
  }

  const localMethods = PERMISSION_METHODS[permissions];
  const methods =
    envelope.methods === null
      ? localMethods
      : localMethods === null
        ? envelope.methods
        : envelope.methods.filter(m => localMethods.includes(m));

  return methods === null ? { policy: 'full' } : { policy: 'methods', methods };
}

/**
 * One-line rendering of a connection's access for the human-readable table.
 * Action lists are truncated — the full list is in `--agent` output.
 */
export function formatAccess(access: ConnectionAccess, maxActions = 2): string {
  switch (access.policy) {
    case 'full':
      return 'full';
    case 'unknown':
      return 'unknown';
    case 'methods':
      return access.methods.length === 0 ? 'none' : access.methods.join(', ');
    case 'actions': {
      if (access.actions.length === 0) return 'none';
      const shown = access.actions.slice(0, maxActions).map(a => `${a.title} (${a.method})`);
      const rest = access.actions.length - shown.length;
      return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
    }
  }
}
