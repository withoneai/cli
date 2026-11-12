import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../../home.js';
import type { SyncProfile } from './types.js';

/**
 * Approval for the shell commands in a project's sync profiles.
 *
 * `transform`, `onInsert`, `onUpdate` and `onChange` run through `sh -c`.
 * Profiles live in the project (`.one/sync/profiles`), so a cloned repo can
 * ship them. Before `sync run` executes any of those commands the user has
 * to approve them, and the approval records a hash of the exact commands:
 * if a later `git pull` changes them, sync stops until they're approved
 * again. Scheduled runs go through the same check.
 *
 * Approvals live in the user's home (~/.one/sync/shell-approvals.json),
 * never in the project, and are keyed by project directory + platform/model.
 */

export const SHELL_FIELDS = ['transform', 'onInsert', 'onUpdate', 'onChange'] as const;
export type ShellField = typeof SHELL_FIELDS[number];

export type ShellCommands = Partial<Record<ShellField, string>>;

interface ApprovalEntry {
  hash: string;
  commands: ShellCommands;
  approvedAt: string;
}

type ApprovalStore = Record<string, ApprovalEntry>;

const STORE_FILE = () => path.join(homeDir(), '.one', 'sync', 'shell-approvals.json');

/** The shell commands a profile would run. The built-in `log` hook is not a shell command. */
export function shellCommandsOf(profile: Partial<SyncProfile>): ShellCommands {
  const out: ShellCommands = {};
  for (const field of SHELL_FIELDS) {
    const value = (profile as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (field !== 'transform' && value === 'log') continue;
    out[field] = value;
  }
  return out;
}

export function hasShellCommands(profile: Partial<SyncProfile>): boolean {
  return Object.keys(shellCommandsOf(profile)).length > 0;
}

function hashCommands(commands: ShellCommands): string {
  const ordered = SHELL_FIELDS.map(f => [f, commands[f] ?? null]);
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function projectRoot(): string {
  try { return fs.realpathSync(process.cwd()); } catch { return path.resolve(process.cwd()); }
}

function keyFor(platform: string, model: string): string {
  return `${projectRoot()}::${platform}/${model}`;
}

function readStore(): ApprovalStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE(), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ApprovalStore : {};
  } catch {
    return {};
  }
}

function writeStore(store: ApprovalStore): void {
  const file = STORE_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** True when the profile has no shell commands, or the user approved exactly these. */
export function isShellApproved(profile: SyncProfile): boolean {
  const commands = shellCommandsOf(profile);
  if (Object.keys(commands).length === 0) return true;
  const entry = readStore()[keyFor(profile.platform, profile.model)];
  return !!entry && entry.hash === hashCommands(commands);
}

/** Record approval of the profile's current shell commands. A profile with none clears any entry. */
export function approveShellCommands(profile: SyncProfile): void {
  const store = readStore();
  const key = keyFor(profile.platform, profile.model);
  const commands = shellCommandsOf(profile);
  if (Object.keys(commands).length === 0) {
    if (!(key in store)) return;
    delete store[key];
  } else {
    store[key] = { hash: hashCommands(commands), commands, approvedAt: new Date().toISOString() };
  }
  writeStore(store);
}

export class SyncShellNotApprovedError extends Error {
  constructor(public readonly profile: SyncProfile, public readonly commands: ShellCommands) {
    const list = Object.entries(commands).map(([f, c]) => `  ${f}: ${c}`).join('\n');
    super(
      `Sync profile ${profile.platform}/${profile.model} runs shell commands that you haven't approved ` +
      `(or that changed since you approved them):\n${list}\n` +
      `Review them, then run: one sync approve ${profile.platform} --models ${profile.model}`
    );
    this.name = 'SyncShellNotApprovedError';
  }
}

/** Throw unless the profile's shell commands are approved. */
export function assertShellApproved(profile: SyncProfile): void {
  if (!isShellApproved(profile)) {
    throw new SyncShellNotApprovedError(profile, shellCommandsOf(profile));
  }
}
