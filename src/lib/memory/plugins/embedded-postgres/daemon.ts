/**
 * Lifecycle of the pgserve daemon behind the embedded-postgres backend:
 * reuse a running daemon we can prove is ours, otherwise clear whatever is
 * holding the cluster and start a fresh one.
 *
 * Every decision is keyed on proof, not on "something is listening". A
 * Postgres is ours only when it reports this cluster's data directory
 * (`SHOW data_directory`). The original implementation treated any listener
 * on the port as its daemon, so on one machine a Teleport `tsh proxy db`
 * tunnel on 5434 was taken for the memory store, pgserve's cluster workers
 * crash-looped on EADDRINUSE into a 44 GB log, and an orphaned Postgres then
 * held the cluster lock for weeks.
 *
 * The daemon is pgserve-launcher.ts, which runs pgserve's Postgres with a
 * per-install superuser password and no router in front of it. Older CLI
 * versions ran pgserve's own server, whose router let any local account in
 * as superuser with no password; a daemon left over from them is stopped and
 * replaced, and its cluster's password is changed on the first start.
 */

import crypto from 'node:crypto';

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const requireFromHere = createRequire(import.meta.url);

export type ProbeResult = 'ours' | 'other' | 'down';

export interface SpawnedDaemon {
  pid: number;
  /** How the process ended ("code 1", "signal SIGKILL"), or null while it runs. */
  exitStatus(): string | null;
}

export interface ProcessInfo {
  ppid: number;
  command: string;
}

export interface DaemonDeps {
  /**
   * Ask whatever listens on `port` which data directory it serves: this
   * cluster ('ours'), anything else or no usable answer ('other'), or
   * nothing listening ('down'). `via` selects what to log in to: the store's
   * database on a running daemon, or whatever Postgres holds the cluster
   * (possibly one an older CLI started with pgserve's default password).
   */
  probe(port: number, via: 'daemon' | 'postmaster'): Promise<ProbeResult>;
  /** Start the launcher detached with `args`, stdout and stderr to `logFd`. */
  spawnPgserve(args: string[], logFd: number): SpawnedDaemon;
  /** Parent PID and command line of a running process; null when unknown. */
  processInfo(pid: number): ProcessInfo | null;
  /** How long to wait for a signalled process to exit. */
  stopTimeoutMs?: number;
}

export interface DaemonConfig {
  dataDir: string;
  /** The store's database; the launcher creates it before reporting ready. */
  database: string;
  host: string;
  port: number;
  /** True when the user set the port, so we must not silently pick another. */
  portExplicit: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  pgvector: boolean;
  startupTimeoutMs: number;
}

/** How far past a taken default port to look for a free one. */
const PORT_SEARCH_SPAN = 20;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_KEEP_BYTES = 1024 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── pidfile ────────────────────────────────────────────────────────────────

interface DaemonRecord {
  pid: number;
  port: number;
  dataDir: string;
  startedAt: string;
  /**
   * 'password' for a pgserve-launcher daemon. Missing for a daemon an older
   * CLI started: pgserve's router, which needs no password.
   */
  auth?: 'password';
}

function pidFilePath(dataDir: string): string {
  return path.join(dataDir, '.pgserve.json');
}

function readPidFile(dataDir: string): DaemonRecord | null {
  try {
    return JSON.parse(fs.readFileSync(pidFilePath(dataDir), 'utf8')) as DaemonRecord;
  } catch {
    return null;
  }
}

function writePidFile(dataDir: string, rec: DaemonRecord): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pidFilePath(dataDir), JSON.stringify(rec, null, 2), { mode: 0o600 });
}

// ─── credentials ────────────────────────────────────────────────────────────

export interface StoreSecrets {
  /** Password of the cluster superuser `postgres`. */
  superuser: string;
  /** Password of the read-only role that raw SQL runs as. */
  reader: string;
}

function secretsPath(dataDir: string): string {
  return path.join(dataDir, '.pgserve-auth.json');
}

/** The launcher writes its PID here once the store is ready to use. */
function readyPath(dataDir: string): string {
  return path.join(dataDir, '.pgserve-ready');
}

function readyPid(dataDir: string): number | null {
  try {
    const { pid } = JSON.parse(fs.readFileSync(readyPath(dataDir), 'utf8')) as { pid?: unknown };
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

/** Marks that the cluster's superuser password is the one in the secrets file. */
function authMarkerPath(dataDir: string): string {
  return path.join(dataDir, '.pgserve-auth-applied');
}

const isSecret = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32,}$/.test(v);

/**
 * The store's passwords, generated on first use and kept in a file only this
 * account can read. The data directory is narrowed to this account too.
 */
export function ensureSecrets(dataDir: string): StoreSecrets {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dataDir, 0o700);
  const file = secretsPath(dataDir);
  for (;;) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreSecrets>;
      if (isSecret(parsed.superuser) && isSecret(parsed.reader)) {
        return { superuser: parsed.superuser, reader: parsed.reader };
      }
      throw new Error(`${file} is not a valid embedded-postgres secrets file. Restore it from a backup; deleting it locks the CLI out of the store.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const fresh: StoreSecrets = {
      superuser: crypto.randomBytes(24).toString('hex'),
      reader: crypto.randomBytes(24).toString('hex'),
    };
    try {
      fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      return fresh;
    } catch (err) {
      // Another invocation wrote it first; read theirs.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

// ─── ports ──────────────────────────────────────────────────────────────────

function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * The port Postgres should listen on. The preferred port wins when it is
 * free. A taken default moves to the next free port; a taken port the user
 * configured is an error, since they may have picked it deliberately.
 */
export async function choosePort(host: string, preferred: number, explicit: boolean): Promise<number> {
  if (await canBind(host, preferred)) return preferred;
  const hint = 'set a different "memory.embedded-postgres.port" in ~/.one/config.json';
  if (explicit) {
    throw new Error(
      `Port ${preferred} on ${host} is already in use ` +
      `by another program, so the embedded Postgres can't start there. Free it, or ${hint}.`,
    );
  }
  for (let port = preferred + 1; port <= preferred + PORT_SEARCH_SPAN; port++) {
    if (await canBind(host, port)) return port;
  }
  throw new Error(
    `Ports ${preferred}-${preferred + PORT_SEARCH_SPAN} on ${host} are all already in use, ` +
    `so the embedded Postgres can't start. Free one, or ${hint}.`,
  );
}

// ─── log ────────────────────────────────────────────────────────────────────

function readRange(file: string, start: number, length: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function fileSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Keep pgserve.log bounded: past `maxBytes`, cut it down to its last
 * `keepBytes`, starting on a line boundary. The daemon writes to the file
 * directly, so this runs before each start rather than continuously.
 */
export function trimLog(logPath: string, maxBytes = LOG_MAX_BYTES, keepBytes = LOG_KEEP_BYTES): void {
  const size = fileSize(logPath);
  if (size <= maxBytes) return;
  const tail = readRange(logPath, size - keepBytes, keepBytes);
  const nl = tail.indexOf(0x0a);
  const kept = nl === -1 ? tail : tail.subarray(nl + 1);
  const notice = `[one] pgserve.log passed ${maxBytes} bytes; kept the last ${kept.length} (${new Date().toISOString()})\n`;
  fs.writeFileSync(logPath, Buffer.concat([Buffer.from(notice), kept]));
}

/** What pgserve wrote since `offset`, without colour codes, for error messages. */
function logSince(logPath: string, offset: number, maxBytes = 2000): string {
  const size = fileSize(logPath);
  const start = Math.max(offset, size - maxBytes);
  if (size <= start) return '';
  return readRange(logPath, start, size - start).toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').trim();
}

// ─── startup lock ───────────────────────────────────────────────────────────

function lockIsStale(lockPath: string, ttlMs: number): boolean {
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs > ttlMs) return true;
    const { pid } = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    return typeof pid === 'number' && !isPidAlive(pid);
  } catch {
    return false; // gone, or mid-write by its holder — the next attempt settles it
  }
}

/**
 * Run `fn` while holding the cluster's startup lock, so concurrent CLI
 * invocations can't each start a daemon, or stop the Postgres another one is
 * in the middle of starting.
 */
async function withStartupLock<T>(dataDir: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(dataDir, '.pgserve.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (lockIsStale(lockPath, waitMs)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for another \`one\` process to start the embedded Postgres (lock: ${lockPath}).`);
    }
    await sleep(100);
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

// ─── stale cluster cleanup ──────────────────────────────────────────────────

/** PID and port of the Postgres holding the cluster, from its postmaster.pid. */
function readPostmasterPid(clusterDir: string): { pid: number; port: number } | null {
  try {
    const lines = fs.readFileSync(path.join(clusterDir, 'postmaster.pid'), 'utf8').split('\n');
    const pid = Number.parseInt(lines[0] ?? '', 10);
    const port = Number.parseInt(lines[3] ?? '', 10);
    return pid > 0 && port > 0 ? { pid, port } : null;
  } catch {
    return null;
  }
}

/** A pgserve server (older CLIs) or launcher (this one) process. */
const DAEMON_COMMAND = /pgserve[\\/]bin[\\/]postgres-server\.js|pgserve-launcher\.[cm]?[jt]s/;

/** The daemon process that started this Postgres, if it is still running. */
function pgserveOwner(postmasterPid: number, deps: DaemonDeps): number | null {
  const ppid = deps.processInfo(postmasterPid)?.ppid;
  if (!ppid || ppid <= 1) return null;
  const command = deps.processInfo(ppid)?.command ?? '';
  return DAEMON_COMMAND.test(command) ? ppid : null;
}

/**
 * Stop a Postgres that holds the cluster when no healthy daemon serves it —
 * an orphan whose pgserve died, or one owned by a pgserve stuck in a crash
 * loop. Either would make every new start fail on the postmaster.pid lock.
 * pgserve already clears a lock whose PID is dead, so only a live holder
 * needs handling here.
 */
async function stopStaleCluster(clusterDir: string, deps: DaemonDeps, timeoutMs: number): Promise<void> {
  const holder = readPostmasterPid(clusterDir);
  if (!holder || !isPidAlive(holder.pid)) return;
  // postmaster.pid can outlive its Postgres and the PID be reused, so only
  // stop a Postgres that proves it serves this cluster.
  if (await deps.probe(holder.port, 'postmaster') !== 'ours') return;

  // pgserve's own shutdown stops its Postgres before it exits. A pgserve
  // stuck in startup never installs that handler and dies on SIGTERM alone,
  // so whatever Postgres is left afterwards gets a "fast" shutdown directly.
  const owner = pgserveOwner(holder.pid, deps);
  if (owner !== null) {
    signal(owner, 'SIGTERM');
    if (!(await waitForExit(owner, timeoutMs))) signal(owner, 'SIGKILL');
  }
  if (!isPidAlive(holder.pid)) return;
  signal(holder.pid, 'SIGINT');
  if (!(await waitForExit(holder.pid, timeoutMs))) {
    throw new Error(
      `The embedded Postgres (PID ${holder.pid}) is holding ${clusterDir} and did not stop. ` +
      `Stop it (kill ${holder.pid}) and retry.`,
    );
  }
}

// ─── ensureRunning ──────────────────────────────────────────────────────────

async function findHealthyDaemon(dataDir: string, deps: DaemonDeps): Promise<number | null> {
  const rec = readPidFile(dataDir);
  // A daemon without `auth` is an older CLI's pgserve router, which lets
  // anyone in without a password. Its trust auth would also pass the probe,
  // so it is never reused; stopLegacyDaemon replaces it.
  if (!rec || rec.auth !== 'password' || !isPidAlive(rec.pid)) return null;
  return (await deps.probe(rec.port, 'daemon')) === 'ours' ? rec.port : null;
}

/**
 * Stop the pgserve router an older CLI recorded in the pidfile. Its Postgres
 * is stopped along with it; stopStaleCluster handles one left behind.
 */
async function stopLegacyDaemon(dataDir: string, deps: DaemonDeps, timeoutMs: number): Promise<void> {
  const rec = readPidFile(dataDir);
  if (!rec || rec.auth === 'password' || !isPidAlive(rec.pid)) return;
  // The PID may have been reused since; only stop a pgserve process.
  if (!/pgserve/.test(deps.processInfo(rec.pid)?.command ?? '')) return;
  signal(rec.pid, 'SIGTERM');
  if (!(await waitForExit(rec.pid, timeoutMs))) signal(rec.pid, 'SIGKILL');
}

function launcherArgs(cfg: DaemonConfig, clusterDir: string, port: number): string[] {
  const args = [
    '--data', clusterDir,
    '--port', String(port),
    '--database', cfg.database,
    '--secrets', secretsPath(cfg.dataDir),
    '--marker', authMarkerPath(cfg.dataDir),
    '--ready', readyPath(cfg.dataDir),
    '--log', cfg.logLevel,
  ];
  if (cfg.pgvector) args.push('--pgvector');
  return args;
}

async function waitUntilServing(
  child: SpawnedDaemon,
  cfg: DaemonConfig,
  port: number,
  deps: DaemonDeps,
  log: { path: string; offset: number },
): Promise<void> {
  const deadline = Date.now() + cfg.startupTimeoutMs;
  const details = () => {
    const tail = logSince(log.path, log.offset);
    return `\nLog: ${log.path}${tail ? `\n${tail}` : ''}`;
  };
  for (;;) {
    const exit = child.exitStatus();
    if (exit) throw new Error(`pgserve exited (${exit}) before it was ready.${details()}`);
    if (readyPid(cfg.dataDir) === child.pid && (await deps.probe(port, 'daemon')) === 'ours') return;
    if (Date.now() >= deadline) {
      throw new Error(
        `pgserve did not start serving on ${cfg.host}:${port} within ${Math.round(cfg.startupTimeoutMs / 1000)}s.${details()}`,
      );
    }
    await sleep(250);
  }
}

/**
 * Make sure a pgserve daemon serving this cluster is running, and return the
 * port it listens on.
 */
export async function ensureRunning(cfg: DaemonConfig, deps: DaemonDeps): Promise<number> {
  const reused = await findHealthyDaemon(cfg.dataDir, deps);
  if (reused !== null) return reused;

  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const stopTimeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  return withStartupLock(cfg.dataDir, cfg.startupTimeoutMs + 4 * stopTimeoutMs, async () => {
    // Another invocation may have finished starting one while we waited.
    const raced = await findHealthyDaemon(cfg.dataDir, deps);
    if (raced !== null) return raced;

    // pgserve passes its --data dir straight to initdb, which refuses to
    // operate on a non-empty directory. Keep the cluster in a `cluster`
    // subdirectory so the log/PID files can sit alongside it.
    const clusterDir = path.join(cfg.dataDir, 'cluster');
    fs.mkdirSync(clusterDir, { recursive: true });
    ensureSecrets(cfg.dataDir);
    await stopLegacyDaemon(cfg.dataDir, deps, stopTimeoutMs);
    await stopStaleCluster(clusterDir, deps, stopTimeoutMs);

    const port = await choosePort(cfg.host, cfg.port, cfg.portExplicit);
    const logPath = path.join(cfg.dataDir, 'pgserve.log');
    trimLog(logPath);
    const log = { path: logPath, offset: fileSize(logPath) };
    fs.rmSync(readyPath(cfg.dataDir), { force: true });
    const fd = fs.openSync(logPath, 'a');
    let child: SpawnedDaemon;
    try {
      child = deps.spawnPgserve(launcherArgs(cfg, clusterDir, port), fd);
    } finally {
      fs.closeSync(fd); // the child holds its own copy
    }

    await waitUntilServing(child, cfg, port, deps, log);
    writePidFile(cfg.dataDir, {
      pid: child.pid,
      port,
      dataDir: cfg.dataDir,
      startedAt: new Date().toISOString(),
      auth: 'password',
    });
    return port;
  });
}

// ─── real dependencies ──────────────────────────────────────────────────────

interface PgProbeClient {
  connect(): Promise<void>;
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: 'error', listener: (err: Error) => void): void;
}

export interface PgClientCtor {
  new (opts: Record<string, unknown>): PgProbeClient;
}

export interface Credentials {
  user: string;
  password: string;
  database: string;
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* not on this machine */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return a !== '' && norm(a) === norm(b);
}

async function probeDataDirectory(
  Client: PgClientCtor,
  target: Credentials & { host: string; port: number },
  clusterDir: string,
): Promise<ProbeResult> {
  const client = new Client({ ...target, connectionTimeoutMillis: 3000, query_timeout: 3000 });
  client.on('error', () => { /* a dropped probe connection is an answer, not a crash */ });
  try {
    await client.connect();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'down' : 'other';
  }
  try {
    const { rows } = await client.query('SHOW data_directory');
    return sameDir(String(rows[0]?.data_directory ?? ''), clusterDir) ? 'ours' : 'other';
  } catch {
    return 'other';
  } finally {
    await client.end().catch(() => {});
  }
}

export interface CommandResult {
  status: number | null;
  output: string;
}

export type RunCommand = (cmd: string, args: string[], cwd?: string) => CommandResult;

const runCommand: RunCommand = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return {
    status: res.status,
    output: [res.stdout, res.stderr, res.error?.message].filter(Boolean).join('\n').trim(),
  };
};

/**
 * Make sure the bundled Bun binary runs. The `bun` package ships a
 * placeholder and swaps in the real binary from its postinstall script.
 * npm 12 blocks dependency install scripts by default, so on a fresh
 * `npm i -g @withone/cli` the placeholder is all there is and Bun won't run.
 * Run that script ourselves once, as pgserve's own wrapper does.
 */
export function ensureBunRuns(bun: string, bunPkgDir: string, run: RunCommand = runCommand): void {
  const probe = run(bun, ['--version']);
  if (probe.status === 0) return;
  // The placeholder is a shell script without a shebang: run directly it
  // fails with ENOEXEC, and through a shell it prints the postinstall error.
  if (!/postinstall script was not run|ENOEXEC/i.test(probe.output)) {
    throw new Error(`pgserve's Bun runtime (${bun}) failed to run: ${probe.output || `exit ${probe.status}`}`);
  }
  const install = run(process.execPath, [path.join(bunPkgDir, 'install.js')], bunPkgDir);
  const again = run(bun, ['--version']);
  if (again.status === 0) return;
  throw new Error(
    `pgserve's Bun runtime (${bun}) is missing its binary, and installing it failed: ` +
    `${install.output || again.output || `exit ${again.status}`}\n` +
    `Fix it by hand: cd ${JSON.stringify(bunPkgDir)} && node install.js`,
  );
}

/** pgserve's bundled Bun runtime, which the launcher needs for PostgresManager. */
function resolveBun(): string {
  // Resolve from pgserve's own location so it follows global vs local
  // installs. The `bun` package installs its platform binary as bin/bun.exe
  // on every OS.
  const pgserveRequire = createRequire(requireFromHere.resolve('pgserve/package.json'));
  const bunPkgDir = path.dirname(pgserveRequire.resolve('bun/package.json'));
  const bun = path.join(bunPkgDir, 'bin', 'bun.exe');
  if (!fs.existsSync(bun)) {
    throw new Error(`pgserve's Bun runtime is missing (${bun}). Reinstall the CLI: npm i -g @withone/cli`);
  }
  ensureBunRuns(bun, bunPkgDir);
  return bun;
}

/** pgserve-launcher, built next to this module (dist) or alongside it in src. */
function resolveLauncher(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'pgserve-launcher.js'), path.join(here, 'pgserve-launcher.ts')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`pgserve-launcher not found next to ${here}. Reinstall the CLI: npm i -g @withone/cli`);
  return found;
}

function spawnLauncher(args: string[], logFd: number, cwd: string): SpawnedDaemon {
  const child = spawn(resolveBun(), [resolveLauncher(), ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd,
    windowsHide: true,
  });
  let status: string | null = null;
  child.once('error', (err) => { status = `failed to start: ${err.message}`; });
  child.once('exit', (code, sig) => { status = sig ? `signal ${sig}` : `code ${code}`; });
  child.unref();
  if (typeof child.pid !== 'number') {
    throw new Error('Failed to start the embedded Postgres: no PID returned.');
  }
  return { pid: child.pid, exitStatus: () => status };
}

function processInfo(pid: number): ProcessInfo | null {
  if (process.platform === 'win32') return null;
  const res = spawnSync('ps', ['-o', 'ppid=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  const match = /^(\d+)\s+(.*)$/.exec((res.stdout ?? '').trim());
  return match ? { ppid: Number(match[1]), command: match[2] } : null;
}

/**
 * The dependencies ensureRunning uses outside tests. A running daemon is
 * probed through the store's database with the superuser password. The
 * Postgres holding the cluster may instead be one an older CLI started,
 * which still has pgserve's default password, so that probe tries both.
 */
export function nodeDaemonDeps(cfg: DaemonConfig, Client: PgClientCtor, secrets: StoreSecrets): DaemonDeps {
  const clusterDir = path.join(cfg.dataDir, 'cluster');
  const login = (port: number, host: string, password: string, database: string) =>
    probeDataDirectory(Client, { host, port, user: 'postgres', password, database }, clusterDir);
  return {
    probe: async (port, via) => {
      if (via === 'daemon') return login(port, cfg.host, secrets.superuser, cfg.database);
      const first = await login(port, '127.0.0.1', secrets.superuser, 'postgres');
      return first === 'other' ? login(port, '127.0.0.1', 'postgres', 'postgres') : first;
    },
    spawnPgserve: (args, logFd) => spawnLauncher(args, logFd, cfg.dataDir),
    processInfo,
  };
}
