import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

/**
 * `one connect create` and `one connect types`: a Connect app described in
 * `one.connect.ts` (typed by `defineConnectApp` from `@withone/connect/config`)
 * becomes an app on One. Everything here is pure or file-local; the command
 * does the network calls.
 */

export const CONFIG_FILES = ['one.connect.ts', 'one.connect.mts', 'one.connect.mjs', 'one.connect.js'] as const;

/** Written beside the config so the editor picks it up like `next-env.d.ts`. */
export const TYPES_FILE = 'one-connect-env.d.ts';

export type ConnectAccess = 'read-only' | 'read-write' | 'full-access';

export type ToolAsk = { access: ConnectAccess } | { access: 'custom'; actions: string[] };

export interface ConnectAppConfig {
  name: string;
  redirectUris: string[];
  description?: string;
  logoUrl?: string;
  homepageUrl?: string;
  reason?: string;
  branding?: { panelColor: string; buttonColor: string; cobrandEmail?: boolean };
  ask?: Record<string, ToolAsk>;
}

/** The dashboard's mapping from a level to the methods a rule admits
 *  (core-ui `policyToRuleFields`); `null` admits every method. */
const ACCESS_METHODS: Record<ConnectAccess, string[] | null> = {
  'read-only': ['GET'],
  'read-write': ['GET', 'POST', 'PUT', 'PATCH'],
  'full-access': null,
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ACTION_ID_PREFIX = 'conn_mod_def::';

export function findConfigFile(cwd: string, explicit?: string): string | null {
  if (explicit) {
    const resolved = path.resolve(cwd, explicit);
    return fs.existsSync(resolved) ? resolved : null;
  }
  for (const name of CONFIG_FILES) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Imports the config's default export. A `.ts` file loads natively on
 * Node 22.18+ (type stripping); older Node gets a message pointing at the
 * `.mjs` form instead of a stack trace.
 */
export async function loadConfigFile(file: string): Promise<unknown> {
  try {
    const mod = await import(pathToFileURL(file).href);
    return mod.default ?? mod;
  } catch (error) {
    const { code, message = '' } = error as { code?: string; message?: string };
    // The config imports the SDK from the project, not from the CLI.
    if (code === 'ERR_MODULE_NOT_FOUND' && message.includes("'@withone/connect'")) {
      throw new Error(
        `it imports @withone/connect, which isn't installed in this project. ` +
          `Run \`npm i @withone/connect\` first.`
      );
    }
    // The path in this message uses the platform's separator: @withone\connect on Windows.
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' && /@withone[\\/]connect/.test(message)) {
      throw new Error(
        `this project's @withone/connect is older than 0.19.0, which added @withone/connect/config. ` +
          `Run \`npm i @withone/connect@latest\` first.`
      );
    }
    if (code === 'ERR_UNKNOWN_FILE_EXTENSION' && /\.m?ts$/.test(file)) {
      throw new Error(
        `Node ${process.versions.node} can't load ${path.basename(file)}. Use Node 22.18 or later, ` +
          `or rename it to one.connect.mjs and type it with ` +
          `/** @type {import("@withone/connect/config").ConnectAppConfig} */.`
      );
    }
    throw error;
  }
}

/** Checks the shape the API would refuse, so the developer hears it before
 *  anything is created. Returns the config typed, or every problem found. */
export function validateConfig(value: unknown): { config: ConnectAppConfig } | { errors: string[] } {
  const errors: string[] = [];
  const v = value as Partial<ConnectAppConfig> | null;
  if (!v || typeof v !== 'object') return { errors: ['The config must export an object (use defineConnectApp).'] };

  if (typeof v.name !== 'string' || !v.name.trim()) errors.push('`name` is required.');
  if (!Array.isArray(v.redirectUris) || v.redirectUris.length === 0) {
    errors.push('`redirectUris` needs at least one callback URL.');
  } else {
    for (const uri of v.redirectUris) {
      if (typeof uri !== 'string' || !/^https?:\/\//.test(uri)) errors.push(`Redirect URI "${uri}" must be an http(s) URL.`);
    }
  }
  if (v.reason !== undefined && (typeof v.reason !== 'string' || v.reason.trim().length === 0 || v.reason.length > 200)) {
    errors.push('`reason` must be one sentence of at most 200 characters.');
  }
  if (v.branding) {
    for (const key of ['panelColor', 'buttonColor'] as const) {
      if (!HEX_COLOR.test(String(v.branding[key] ?? ''))) errors.push(`\`branding.${key}\` must be a #RRGGBB colour.`);
    }
  }
  for (const [tool, ask] of Object.entries(v.ask ?? {})) {
    const access = (ask as { access?: unknown })?.access;
    if (access === 'custom') {
      const actions = (ask as { actions?: unknown }).actions;
      if (!Array.isArray(actions) || actions.length === 0) errors.push(`\`ask.${tool}\` is custom, so it needs at least one action.`);
    } else if (typeof access !== 'string' || !(access in ACCESS_METHODS)) {
      errors.push(`\`ask.${tool}.access\` must be read-only, read-write, full-access or custom.`);
    }
  }

  return errors.length > 0 ? { errors } : { config: v as ConnectAppConfig };
}

/**
 * The name an action goes by in the config: its title in camel case.
 * "List and View Email Threads" → "listAndViewEmailThreads".
 */
export function actionName(title: string): string {
  const words = title.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words
    .map((word, i) => (i === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()))
    .join('');
}

/**
 * Names for a tool's actions, keyed by name. A name two actions share is
 * left out: those actions are reachable by id only, so a name never picks
 * one of them silently.
 */
export function actionNames(actions: Array<{ systemId: string; title: string }>): Map<string, string> {
  const byName = new Map<string, string>();
  const shared = new Set<string>();
  for (const action of actions) {
    const name = actionName(action.title);
    if (!name) continue;
    if (byName.has(name)) shared.add(name);
    else byName.set(name, action.systemId);
  }
  for (const name of shared) byName.delete(name);
  return byName;
}

/** Turns a custom ask's names and ids into ids, or names what didn't match. */
export function resolveActions(
  refs: string[],
  names: Map<string, string>,
  ids: Set<string>
): { ids: string[] } | { unknown: string[] } {
  const resolved: string[] = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const id = ref.startsWith(ACTION_ID_PREFIX) ? (ids.has(ref) ? ref : undefined) : names.get(ref);
    if (id) resolved.push(id);
    else unknown.push(ref);
  }
  return unknown.length > 0 ? { unknown } : { ids: [...new Set(resolved)] };
}

export interface ConnectorRule {
  type: 'connectionDefinition';
  connectionDefinitionId: number;
  methods: string[] | null;
  actionIds: string[] | null;
}

/** One tool's rule, shaped as the dashboard writes it. */
export function connectorRule(connectionDefinitionId: number, ask: ToolAsk, actionIds: string[] = []): ConnectorRule {
  if (ask.access === 'custom') return { type: 'connectionDefinition', connectionDefinitionId, methods: null, actionIds };
  return { type: 'connectionDefinition', connectionDefinitionId, methods: ACCESS_METHODS[ask.access], actionIds: null };
}

/** The app's fields as the client API takes them. Only what the file sets is
 *  sent, so an update leaves everything else as it is. */
export function clientFields(config: ConnectAppConfig): Record<string, unknown> {
  const fields: Record<string, unknown> = { name: config.name.trim(), redirectUris: config.redirectUris };
  if (config.description) fields.description = config.description;
  if (config.logoUrl) fields.logoUrl = config.logoUrl;
  if (config.homepageUrl) fields.homepageUrl = config.homepageUrl;
  if (config.reason) fields.consentReason = config.reason.trim();
  if (config.branding) {
    fields.frontend = {
      panelColor: config.branding.panelColor,
      buttonColor: config.branding.buttonColor,
      cobrandEmail: config.branding.cobrandEmail ?? false,
    };
  }
  return fields;
}

/**
 * What `one connect create` hands the setup page: the app's fields and its
 * ask, already resolved to catalog ids. The page shows it for review and
 * writes it with the person's dashboard session, so an API key never
 * creates or changes a Connect app. `ask` is null when the config asks for
 * nothing, which leaves an existing ask as it is.
 */
export interface ConnectHandoff {
  v: 1;
  app: Record<string, unknown>;
  ask: ConnectorRule[] | null;
}

export function buildHandoff(config: ConnectAppConfig, rules: ConnectorRule[]): ConnectHandoff {
  return { v: 1, app: clientFields(config), ask: rules.length > 0 ? rules : null };
}

/**
 * The handoff as the link's fragment carries it: JSON, deflated (the
 * browser inflates it with its built-in DecompressionStream), then
 * base64url. The fragment never reaches a server, so size is bounded only
 * by what can open a URL; deflate roughly halves a long list of action ids.
 */
export function encodeHandoff(handoff: ConnectHandoff): string {
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(handoff), 'utf8'), { level: 9 }).toString('base64url');
}

/** Past this the link is too long for a terminal to hand over reliably;
 *  far beyond any real app (about 30 custom tools of 30 actions each). */
export const MAX_HANDOFF_LENGTH = 32_000;

/** Windows opens links through PowerShell, whose command line holds a
 *  URL of about 12,000 characters; past this the CLI prints it instead. */
export const MAX_WINDOWS_OPEN_LENGTH = 11_000;

/** `.env.local` when the project has one (Next.js), else `.env`. */
export function defaultEnvFile(cwd: string): string {
  const local = path.join(cwd, '.env.local');
  return fs.existsSync(local) ? local : path.join(cwd, '.env');
}

export function readEnvValue(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

/**
 * Sets each key in place, keeping every other line and comment. A key that
 * is missing is appended; `null` appends it empty only when it is missing, so
 * a secret already pasted in is never cleared.
 */
export function upsertEnv(text: string, values: Record<string, string | null>): string {
  let next = text;
  const appended: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^${key}=.*$`, 'm');
    if (line.test(next)) {
      if (value !== null) next = next.replace(line, `${key}=${value}`);
    } else {
      appended.push(`${key}=${value ?? ''}`);
    }
  }
  if (appended.length === 0) return next;
  const separator = next.length === 0 || next.endsWith('\n') ? '' : '\n';
  return `${next}${separator}${appended.join('\n')}\n`;
}

/** The declaration file `one connect types` writes. */
export function renderTypes(tools: string[], actionsByTool: Record<string, string[]>): string {
  const literal = (value: string) => JSON.stringify(value);
  const union = (values: string[]) => (values.length > 0 ? values.map(literal).join(' | ') : 'never');
  const actionLines = Object.entries(actionsByTool)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, names]) => `      ${literal(tool)}: ${union([...names].sort())};`);

  return [
    '// Generated by `one connect types`. Run it again after changing the tools in one.connect.ts.',
    'import "@withone/connect/config";',
    '',
    'declare module "@withone/connect/config" {',
    '  interface ConnectRegistry {',
    `    tools: ${union([...tools].sort())};`,
    '    actions: {',
    ...actionLines,
    '    };',
    '  }',
    '}',
    '',
  ].join('\n');
}
