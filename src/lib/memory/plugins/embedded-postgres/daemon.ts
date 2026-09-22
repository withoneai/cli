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
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
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
   * nothing listening ('down'). `via` selects the credentials — pgserve's
   * router, or the cluster's Postgres directly.
   */
  probe(port: number, via: 'router' | 'postmaster'): Promise<ProbeResult>;
  /** Start pgserve detached with `args`, stdout and stderr to `logFd`. */
  spawnPgserve(args: string[], logFd: number): SpawnedDaemon;
  /** Parent PID and command line of a running process; null when unknown. */
  processInfo(pid: number): ProcessInfo | null;
  /** How long to wait for a signalled process to exit. */
  stopTimeoutMs?: number;
}

export interface DaemonConfig {
  dataDir: string;
  host: string;
  port: number;
  /** True when the user set the port, so we must not silently pick another. */
  portExplicit: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  pgvector: boolean;
  startupTimeoutMs: number;
}

/** pgserve puts its internal Postgres at the router port + 1000. */
const PG_PORT_OFFSET = 1000;
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

async function portPairFree(host: string, port: number): Promise<boolean> {
  return port + PG_PORT_OFFSET <= 65535
    && await canBind(host, port)
    && await canBind('127.0.0.1', port + PG_PORT_OFFSET);
}

/**
 * The port pgserve should listen on. The preferred port wins when both it
 * and its internal Postgres port are free. A taken default moves to the next
 * free pair; a taken port the user configured is an error, since they may
 * have picked it deliberately.
 */
export async function choosePort(host: string, preferred: number, explicit: boolean): Promise<number> {
  if (await portPairFree(host, preferred)) return preferred;
  const hint = 'set a different "memory.embedded-postgres.port" in ~/.one/config.json';
  if (explicit) {
    throw new Error(
      `Port ${preferred} (or ${preferred + PG_PORT_OFFSET}, its internal Postgres port) on ${host} is already in use ` +
      `by another program, so the embedded Postgres can't start there. Free it, or ${hint}.`,
    );
  }
  for (let port = preferred + 1; port <= preferred + PORT_SEARCH_SPAN; port++) {
    if (await portPairFree(host, port)) return port;
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

/** The pgserve process that started this Postgres, if it is still running. */
function pgserveOwner(postmasterPid: number, deps: DaemonDeps): number | null {
  const ppid = deps.processInfo(postmasterPid)?.ppid;
  if (!ppid || ppid <= 1) return null;
  const command = deps.processInfo(ppid)?.command ?? '';
  return /pgserve[\\/]bin[\\/]postgres-server\.js/.test(command) ? ppid : null;
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
  if (!rec || !isPidAlive(rec.pid)) return null;
  return (await deps.probe(rec.port, 'router')) === 'ours' ? rec.port : null;
}

function pgserveArgs(cfg: DaemonConfig, clusterDir: string, port: number): string[] {
  const args = [
    '--data', clusterDir,
    '--port', String(port),
    '--host', cfg.host,
    '--log', cfg.logLevel,
    '--no-stats',
    // Single process. In cluster mode a worker that can't bind the port is
    // re-forked immediately, forever, each crash logging a full stack trace.
    '--no-cluster',
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
    if ((await deps.probe(port, 'router')) === 'ours') return;
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
  return withStartupLock(cfg.dataDir, cfg.startupTimeoutMs + 3 * stopTimeoutMs, async () => {
    // Another invocation may have finished starting one while we waited.
    const raced = await findHealthyDaemon(cfg.dataDir, deps);
    if (raced !== null) return raced;

    // pgserve passes its --data dir straight to initdb, which refuses to
    // operate on a non-empty directory. Keep the cluster in a `cluster`
    // subdirectory so the log/PID files can sit alongside it.
    const clusterDir = path.join(cfg.dataDir, 'cluster');
    fs.mkdirSync(clusterDir, { recursive: true });
    await stopStaleCluster(clusterDir, deps, stopTimeoutMs);

    const port = await choosePort(cfg.host, cfg.port, cfg.portExplicit);
    const logPath = path.join(cfg.dataDir, 'pgserve.log');
    trimLog(logPath);
    const log = { path: logPath, offset: fileSize(logPath) };
    const fd = fs.openSync(logPath, 'a');
    let child: SpawnedDaemon;
    try {
      child = deps.spawnPgserve(pgserveArgs(cfg, clusterDir, port), fd);
    } finally {
      fs.closeSync(fd); // the child holds its own copy
    }

    await waitUntilServing(child, cfg, port, deps, log);
    writePidFile(cfg.dataDir, {
      pid: child.pid,
      port,
      dataDir: cfg.dataDir,
      startedAt: new Date().toISOString(),
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

function resolvePgserveBin(): string {
  // Resolve via createRequire so the binary follows the package on
  // global vs local installs. `bin/pgserve-wrapper.cjs` is the
  // platform-portable entry that bootstraps the bundled Bun runtime +
  // Postgres binaries.
  const pkg = requireFromHere.resolve('pgserve/package.json');
  return path.resolve(path.dirname(pkg), 'bin/pgserve-wrapper.cjs');
}

function spawnPgserve(args: string[], logFd: number, cwd: string): SpawnedDaemon {
  const child = spawn(process.execPath, [resolvePgserveBin(), ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // pgserve resolves the bundled bun binary relative to its own package
    // location, not cwd, so cwd doesn't matter — but pin it for clarity.
    cwd,
  });
  let status: string | null = null;
  child.once('error', (err) => { status = `failed to start: ${err.message}`; });
  child.once('exit', (code, sig) => { status = sig ? `signal ${sig}` : `code ${code}`; });
  child.unref();
  if (typeof child.pid !== 'number') {
    throw new Error('Failed to spawn pgserve — no PID returned.');
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
 * The dependencies ensureRunning uses outside tests. `router` credentials
 * are the ones the backend connects with; pgserve's bundled superuser
 * (`postgres`/`postgres`) reaches the cluster's Postgres directly.
 */
export function nodeDaemonDeps(cfg: DaemonConfig, Client: PgClientCtor, router: Credentials): DaemonDeps {
  const clusterDir = path.join(cfg.dataDir, 'cluster');
  const direct: Credentials = { user: 'postgres', password: 'postgres', database: 'postgres' };
  return {
    probe: (port, via) =>
      probeDataDirectory(
        Client,
        via === 'router' ? { host: cfg.host, port, ...router } : { host: '127.0.0.1', port, ...direct },
        clusterDir,
      ),
    spawnPgserve: (args, logFd) => spawnPgserve(args, logFd, cfg.dataDir),
    processInfo,
  };
}
