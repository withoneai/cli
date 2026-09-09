import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir } from './home.js';
import { detectInstalledAgents } from './agents.js';
import { getDeviceId, getProjectRoot, type ConfigScope } from './config.js';
import { cliVersion } from './version.js';

/**
 * What the CLI tells the browser consent page about where it lives. Every
 * field except `scope` is best-effort: a value that cannot be read is
 * simply absent, and login never fails because of it. The page turns these
 * into tags on the minted key (see the spec's tag vocabulary).
 */
export interface InstallContext {
  scope: ConfigScope;
  /** Project root; only for project scope. */
  path?: string;
  host?: string;
  /** process.platform: darwin / linux / win32. */
  os?: string;
  /** os.release(), e.g. 25.2.0 on macOS 26. */
  osVersion?: string;
  arch?: string;
  /** OS account name on this machine. */
  user?: string;
  /** Stable per-install id from ~/.one/device-id. */
  device?: string;
  cli?: string;
  /** Harness ids found installed on this machine. */
  harnesses: string[];
  /** Harness that spawned this CLI process, when an agent ran it. */
  launcher?: string;
}

/**
 * Harnesses the CLI can notice on disk beyond the MCP-capable agents in
 * agents.ts. Ids are the shared vocabulary the consent page's catalog uses.
 * Dirs are relative to the home directory and resolved per call.
 */
const EXTRA_HARNESS_DIRS: ReadonlyArray<{ id: string; dir: string }> = [
  { id: 'gemini-cli', dir: '.gemini' },
  { id: 'openclaw', dir: '.openclaw' },
  { id: 'hermes', dir: '.hermes' },
  { id: 'devin', dir: '.devin' },
];

/**
 * Env markers agents export to the processes they spawn. Checked in order;
 * the first hit wins, so more specific tools sit above generic ones.
 */
const LAUNCHER_ENV: ReadonlyArray<{ id: string; vars: string[] }> = [
  { id: 'claude-code', vars: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] },
  { id: 'codex', vars: ['CODEX_SANDBOX', 'CODEX_CI', 'CODEX_THREAD_ID'] },
  { id: 'gemini-cli', vars: ['GEMINI_CLI'] },
  { id: 'cursor', vars: ['CURSOR_AGENT', 'CURSOR_TRACE_ID'] },
  { id: 'windsurf', vars: ['WINDSURF_AGENT'] },
  { id: 'kiro', vars: ['KIRO_AGENT'] },
  { id: 'openclaw', vars: ['OPENCLAW_AGENT', 'OPENCLAW_SESSION'] },
  { id: 'hermes', vars: ['HERMES_AGENT', 'HERMES_SESSION'] },
  { id: 'devin', vars: ['DEVIN_SESSION_ID'] },
];

/** The harness that launched this process, if an agent did. */
export function detectLauncher(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const entry of LAUNCHER_ENV) {
    if (entry.vars.some(v => env[v] !== undefined && env[v] !== '')) return entry.id;
  }
  return undefined;
}

/** Harness ids whose config directory exists under the home directory. */
export function detectInstalledHarnesses(): string[] {
  const ids = new Set<string>(detectInstalledAgents().map(a => a.id));
  for (const { id, dir } of EXTRA_HARNESS_DIRS) {
    if (fs.existsSync(path.join(homeDir(), dir))) ids.add(id);
  }
  return [...ids].sort();
}

function tryRead<T>(read: () => T): T | undefined {
  try {
    const value = read();
    return value === null || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

export function collectInstallContext(opts: {
  scope: ConfigScope;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}): InstallContext {
  const env = opts.env ?? process.env;
  const ctx: InstallContext = {
    scope: opts.scope,
    harnesses: tryRead(() => detectInstalledHarnesses()) ?? [],
  };
  if (opts.scope === 'project') {
    ctx.path = opts.projectRoot ?? tryRead(() => getProjectRoot());
  }
  ctx.host = tryRead(() => os.hostname());
  ctx.os = process.platform;
  ctx.osVersion = tryRead(() => os.release());
  ctx.arch = process.arch;
  ctx.user = tryRead(() => os.userInfo().username);
  ctx.device = tryRead(() => getDeviceId());
  ctx.cli = tryRead(() => cliVersion());
  ctx.launcher = detectLauncher(env);
  return ctx;
}

/** Query-string encoding of the context, under the names the page reads. */
export function installContextToParams(ctx: InstallContext): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== '') params.set(key, value);
  };
  set('scope', ctx.scope);
  set('path', ctx.path);
  set('host', ctx.host);
  set('os', ctx.os);
  set('osv', ctx.osVersion);
  set('arch', ctx.arch);
  set('user', ctx.user);
  set('device', ctx.device);
  set('cli', ctx.cli);
  if (ctx.harnesses.length > 0) params.set('harnesses', ctx.harnesses.join(','));
  set('launcher', ctx.launcher);
  return params;
}

/** Terminal-friendly summary of what the consent page will record. */
export function describeInstallContext(ctx: InstallContext): string {
  const lines: string[] = [`scope: ${ctx.scope}`];
  if (ctx.path) lines.push(`path: ${ctx.path}`);
  if (ctx.host || ctx.os) {
    const osPart = [ctx.os, ctx.osVersion].filter(Boolean).join(' ');
    const detail = [osPart, ctx.arch].filter(Boolean).join(', ');
    lines.push(`machine: ${ctx.host ?? 'unknown'}${detail ? ` (${detail})` : ''}`);
  }
  if (ctx.user) lines.push(`user: ${ctx.user}`);
  if (ctx.harnesses.length > 0) lines.push(`harnesses: ${ctx.harnesses.join(', ')}`);
  if (ctx.launcher) lines.push(`launched by: ${ctx.launcher}`);
  if (ctx.cli) lines.push(`cli: ${ctx.cli}`);
  return lines.join('\n');
}
