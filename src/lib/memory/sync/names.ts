import fs from 'node:fs';
import path from 'node:path';

/**
 * Sync profile platform and model names become parts of file paths (locks,
 * event logs, profiles, databases). Profiles can come from a cloned repo, so
 * a name must be a single plain path segment: no separators, no `..`.
 * Every built-in profile name matches this pattern.
 */
const SAFE_SYNC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeSyncName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 128
    && SAFE_SYNC_NAME.test(value)
    && !value.includes('..');
}

export class UnsafeSyncNameError extends Error {
  constructor(kind: 'platform' | 'model', value: unknown) {
    super(
      `Invalid sync ${kind} name ${JSON.stringify(value)}: use letters, digits, ".", "_" or "-", ` +
      `starting with a letter or digit, and no "..".`
    );
    this.name = 'UnsafeSyncNameError';
  }
}

export function assertSafeSyncNames(platform: unknown, model?: unknown): void {
  if (!isSafeSyncName(platform)) throw new UnsafeSyncNameError('platform', platform);
  if (model !== undefined && !isSafeSyncName(model)) throw new UnsafeSyncNameError('model', model);
}

/**
 * Create `dirRel` (relative to the working directory) and refuse it if it
 * resolves outside the working directory, e.g. because `.one/sync/locks` is
 * a symlink committed to the repo. Returns the directory path unchanged.
 */
export function ensureDirInsideProject(dirRel: string): string {
  fs.mkdirSync(dirRel, { recursive: true });
  const root = fs.realpathSync(process.cwd());
  const real = fs.realpathSync(dirRel);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`Refusing to use ${dirRel}: it resolves outside the project (${real}).`);
  }
  return dirRel;
}
