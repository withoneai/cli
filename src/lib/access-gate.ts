/**
 * The one place the CLI's local access settings are enforced on an action
 * call. Every passthrough request goes through `OneApi.executePassthroughRequest`,
 * which runs `checkPassthroughAccess` before anything is sent, so a command,
 * flow step, sync or validation run cannot reach a connected app on a path that
 * skips the settings. Commands still check early for a friendlier message; this
 * is the check that cannot be forgotten.
 *
 * The settings (`one config`, narrowed by `.onerc`) are a real limit on what
 * this CLI may do, typically for an agent: knowledge-only turns execution off,
 * the allowlists name the connections and actions that may run, and the
 * permission level names the HTTP methods that may be sent.
 */

import type { AccessControlSettings, PermissionLevel } from './types.js';

/** `null` means "no method restriction" (admin). */
export const PERMISSION_METHODS: Record<PermissionLevel, string[] | null> = {
  read: ['GET'],
  write: ['GET', 'POST', 'PUT', 'PATCH'],
  admin: null,
};

export function isMethodAllowed(method: string, permissions: PermissionLevel): boolean {
  const allowed = PERMISSION_METHODS[permissions];
  if (allowed === null) return true;
  return allowed.includes(method.toUpperCase());
}

export function isActionAllowed(actionId: string, allowedActionIds: string[]): boolean {
  return allowedActionIds.includes('*') || allowedActionIds.includes(actionId);
}

export function isConnectionAllowed(connectionKey: string, allowedConnectionKeys: string[]): boolean {
  return allowedConnectionKeys.includes('*') || allowedConnectionKeys.includes(connectionKey);
}

/**
 * Headers the CLI sets from the values the gate approved. One reads the key,
 * connection and action from these, so a caller-supplied copy would replace
 * what was checked.
 */
export const IDENTITY_HEADERS = ['x-one-secret', 'x-one-connection-key', 'x-one-action-id'];

/**
 * Headers that ask an upstream to treat the request as another method. One
 * forwards them, so under a method limit they are judged like the method.
 */
export const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override'];

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

export interface PassthroughRequest {
  actionId: string;
  connectionKey: string;
  method: string;
  headers?: Record<string, string>;
}

/** Throws `AccessDeniedError` naming the first rule the request breaks. */
export function checkPassthroughAccess(settings: AccessControlSettings, req: PassthroughRequest): void {
  const permissions = settings.permissions ?? 'admin';
  const actionIds = settings.actionIds ?? ['*'];
  const connectionKeys = settings.connectionKeys ?? ['*'];

  if (settings.knowledgeAgent) {
    throw new AccessDeniedError('Action execution is disabled (knowledge-only mode).');
  }
  if (!isActionAllowed(req.actionId, actionIds)) {
    throw new AccessDeniedError(`Action "${req.actionId}" is not in the allowed action list.`);
  }
  if (!isConnectionAllowed(req.connectionKey, connectionKeys)) {
    throw new AccessDeniedError(`Connection key "${req.connectionKey}" is not allowed.`);
  }
  if (!isMethodAllowed(req.method, permissions)) {
    throw new AccessDeniedError(`Method "${req.method}" is not allowed under "${permissions}" permission level.`);
  }

  for (const [name, value] of Object.entries(req.headers ?? {})) {
    const lower = name.toLowerCase();
    if (IDENTITY_HEADERS.includes(lower)) {
      throw new AccessDeniedError(
        `Header "${name}" is set by the CLI and cannot be passed. Use --connection-key and the action id instead.`
      );
    }
    if (METHOD_OVERRIDE_HEADERS.includes(lower) && !isMethodAllowed(String(value), permissions)) {
      throw new AccessDeniedError(
        `Header "${name}: ${value}" asks for a method that is not allowed under "${permissions}" permission level.`
      );
    }
  }
}

const LEVEL_RANK: Record<PermissionLevel, number> = { read: 0, write: 1, admin: 2 };

export function isPermissionLevel(value: string): value is PermissionLevel {
  return value in LEVEL_RANK;
}

/** The stricter of two levels. */
export function stricterLevel(a: PermissionLevel, b: PermissionLevel): PermissionLevel {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

/** Both allowlists must allow an entry; `*` allows everything. */
export function intersectAllowlists(a: string[], b: string[]): string[] {
  if (a.includes('*')) return b;
  if (b.includes('*')) return a;
  return a.filter(x => b.includes(x));
}

// ── One's own resources: relays and connections ───────────────────────

/**
 * A command that changes a One resource rather than calling a connected app,
 * named by the HTTP method it sends: `write` for create, update and activate,
 * `delete` for delete. Knowledge-only refuses both, and the permission level
 * must allow the method, the same way it would for an action.
 */
export function checkManagementAccess(settings: AccessControlSettings, op: 'write' | 'delete', what: string): void {
  const permissions = settings.permissions ?? 'admin';
  if (settings.knowledgeAgent) {
    throw new AccessDeniedError(`${what} is disabled (knowledge-only mode).`);
  }
  const method = op === 'delete' ? 'DELETE' : 'POST';
  if (!isMethodAllowed(method, permissions)) {
    throw new AccessDeniedError(`${what} needs ${op === 'delete' ? 'the "admin"' : 'the "write" or "admin"'} permission level (current: "${permissions}").`);
  }
}

/** True when neither allowlist names anything, so nothing narrower than "all" applies. */
export function allowlistsUnrestricted(settings: AccessControlSettings): boolean {
  return (settings.actionIds ?? ['*']).includes('*') && (settings.connectionKeys ?? ['*']).includes('*');
}

/**
 * Checks the actions a relay will run when its webhook events arrive. They run
 * on One's servers later, so this is the only moment the CLI can apply its
 * settings to them:
 * - a `passthrough` action is judged like `actions execute` (allowlists,
 *   method, headers), using `methodOf` to read the action's method;
 * - a `url` or `agent` action sends event data somewhere the allowlists cannot
 *   describe, so it is allowed only when both allowlists are `*`.
 */
export async function checkRelayActions(
  settings: AccessControlSettings,
  actions: unknown,
  methodOf: (actionId: string) => Promise<string>,
): Promise<void> {
  if (actions === undefined || actions === null) return;
  if (!Array.isArray(actions)) throw new AccessDeniedError('--actions must be a JSON array.');
  for (const [i, raw] of actions.entries()) {
    const action = (raw ?? {}) as Record<string, unknown>;
    if (action.type === 'passthrough') {
      const actionId = String(action.actionId ?? '');
      const connectionKey = String(action.connectionKey ?? '');
      if (!actionId || !connectionKey) {
        throw new AccessDeniedError(`Relay action [${i}] needs an actionId and a connectionKey.`);
      }
      // Allowlists first, so a refused action costs no lookup.
      checkPassthroughAccess({ ...settings, permissions: 'admin', knowledgeAgent: false }, { actionId, connectionKey, method: 'GET' });
      const headers = action.headers && typeof action.headers === 'object' ? (action.headers as Record<string, string>) : undefined;
      checkPassthroughAccess(settings, { actionId, connectionKey, method: await methodOf(actionId), headers });
      continue;
    }
    if (!allowlistsUnrestricted(settings)) {
      throw new AccessDeniedError(
        `Relay action [${i}] of type "${String(action.type)}" forwards events outside the connection and action allowlists, so it is allowed only when both are "*".`,
      );
    }
  }
}
