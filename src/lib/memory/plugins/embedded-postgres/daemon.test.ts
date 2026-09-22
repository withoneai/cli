/**
 * Daemon lifecycle for the embedded-postgres backend.
 *
 * These cover the failure that filled a user's disk with a 44 GB
 * `pgserve.log`: another program (a Teleport `tsh proxy db` tunnel) held the
 * default port, pgserve's cluster workers crash-looped on EADDRINUSE with no
 * backoff, the CLI mistook the tunnel for its own daemon because it only
 * checked "is something listening", and an orphaned Postgres then held the
 * cluster lock for weeks.
 *
 * Ports, pidfiles, logs and the processes that get signalled are all real.
 * Only the two things that would need a real Postgres are faked: the probe
 * (which asks a listener what data directory it serves) and the pgserve spawn.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { withTempHome, assertHomeIsSandboxed } from '../../../../test-support/home.js';
import {
  ensureRunning,
  choosePort,
  trimLog,
  type DaemonConfig,
  type DaemonDeps,
  type ProbeResult,
} from './daemon.js';
import { embeddedPostgresPlugin } from './index.js';

const HOST = '127.0.0.1';

// ─── helpers ────────────────────────────────────────────────────────────────

const servers: net.Server[] = [];
const children: ChildProcess[] = [];

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => sock.destroy());
    server.once('error', reject);
    server.listen(port, HOST, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, HOST, () => s.close(() => resolve(true)));
  });
}

/** A port P where both P and P+1000 (pgserve's internal Postgres port) are free. */
async function freePort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const p = 20000 + Math.floor(Math.random() * 20000);
    if (await canBind(p) && await canBind(p + 1000)) return p;
  }
  throw new Error('no free port pair found');
}

/** A real, long-lived process to stand in for postgres or pgserve. */
function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function config(home: { oneDir: string }, port: number, portExplicit = false): DaemonConfig {
  return {
    dataDir: path.join(home.oneDir, 'pg'),
    host: HOST,
    port,
    portExplicit,
    logLevel: 'warn',
    pgvector: false,
    startupTimeoutMs: 5000,
  };
}

function writePidFile(cfg: DaemonConfig, pid: number, port: number): void {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfg.dataDir, '.pgserve.json'),
    JSON.stringify({ pid, port, dataDir: cfg.dataDir, startedAt: new Date().toISOString() }),
  );
}

function readPidFile(cfg: DaemonConfig): { pid: number; port: number } | null {
  try { return JSON.parse(fs.readFileSync(path.join(cfg.dataDir, '.pgserve.json'), 'utf8')); } catch { return null; }
}

/** What Postgres writes to <cluster>/postmaster.pid while it holds the cluster. */
function writePostmasterPid(cfg: DaemonConfig, pid: number, port: number): void {
  const clusterDir = path.join(cfg.dataDir, 'cluster');
  fs.mkdirSync(clusterDir, { recursive: true });
  fs.writeFileSync(
    path.join(clusterDir, 'postmaster.pid'),
    [pid, clusterDir, Math.floor(Date.now() / 1000), port, '/tmp', 'localhost', '1 2', 'ready', ''].join('\n'),
  );
}

/**
 * Fake pgserve: "spawning" starts a real listener on the requested port and
 * marks that port as serving this cluster. The default probe reports 'ours'
 * for those ports, 'other' for any other listener, and 'down' otherwise.
 */
function fakeDeps(overrides: Partial<DaemonDeps> = {}, opts: { readyAfterMs?: number } = {}) {
  const ours = new Set<number>();
  const spawned: string[][] = [];
  const deps: DaemonDeps = {
    async probe(port: number): Promise<ProbeResult> {
      if (ours.has(port)) return 'ours';
      return (await canBind(port)) ? 'down' : 'other';
    },
    spawnPgserve(args: string[]) {
      spawned.push(args);
      const port = Number(args[args.indexOf('--port') + 1]);
      const start = () => { void listen(port).then(() => ours.add(port)); };
      if (opts.readyAfterMs) setTimeout(start, opts.readyAfterMs);
      else start();
      return { pid: process.pid, exitStatus: () => null };
    },
    processInfo: () => null,
    stopTimeoutMs: 500,
    ...overrides,
  };
  return { deps, ours, spawned };
}

const home = withTempHome();
beforeEach(() => home.setup());
afterEach(async () => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  home.teardown();
});

// ─── config ─────────────────────────────────────────────────────────────────

describe('embedded-postgres config', () => {
  it('marks a port the user set as explicit', () => {
    const cfg = embeddedPostgresPlugin.parseConfig({ port: 6000 }) as unknown as DaemonConfig;
    assert.equal(cfg.port, 6000);
    assert.equal(cfg.portExplicit, true);
  });

  it('treats the default port as movable', () => {
    const cfg = embeddedPostgresPlugin.parseConfig({}) as unknown as DaemonConfig;
    assert.equal(cfg.port, 5434);
    assert.equal(cfg.portExplicit, false);
  });
});

// ─── choosePort ─────────────────────────────────────────────────────────────

describe('choosePort', () => {
  it('uses the preferred port when it is free', async () => {
    const p = await freePort();
    assert.equal(await choosePort(HOST, p, false), p);
  });

  it('moves past a default port that another program is listening on', async () => {
    const p = await freePort();
    await listen(p);
    const chosen = await choosePort(HOST, p, false);
    assert.notEqual(chosen, p);
    assert.ok(await canBind(chosen), `chosen port ${chosen} should be free`);
  });

  it('skips a port whose internal Postgres port (+1000) is taken', async () => {
    const p = await freePort();
    await listen(p + 1000);
    assert.notEqual(await choosePort(HOST, p, false), p);
  });

  it('refuses an explicitly configured port that another program holds', async () => {
    const p = await freePort();
    await listen(p);
    await assert.rejects(choosePort(HOST, p, true), (err: Error) => {
      assert.match(err.message, new RegExp(`${p}`));
      assert.match(err.message, /already in use/);
      assert.match(err.message, /embedded-postgres/);
      return true;
    });
  });
});

// ─── trimLog ────────────────────────────────────────────────────────────────

describe('trimLog', () => {
  it('cuts an oversized log down to its most recent lines', () => {
    assertHomeIsSandboxed();
    const log = path.join(home.oneDir, 'pgserve.log');
    const line = 'x'.repeat(99) + '\n';
    fs.writeFileSync(log, line.repeat(3000) + 'the last line\n');

    trimLog(log, 100_000, 10_000);

    const after = fs.readFileSync(log, 'utf8');
    assert.ok(after.length <= 10_000 + 200, `trimmed log is ${after.length} bytes`);
    assert.ok(after.endsWith('the last line\n'));
    // Starts on a line boundary: no half-line fragment after the notice.
    const body = after.split('\n').slice(1, -2);
    assert.ok(body.every((l) => l === 'x'.repeat(99)), 'kept lines are whole');
  });

  it('leaves a log under the cap alone', () => {
    assertHomeIsSandboxed();
    const log = path.join(home.oneDir, 'pgserve.log');
    fs.writeFileSync(log, 'small\n');
    trimLog(log, 100_000, 10_000);
    assert.equal(fs.readFileSync(log, 'utf8'), 'small\n');
  });
});

// ─── ensureRunning ──────────────────────────────────────────────────────────

describe('ensureRunning', () => {
  it('reuses a recorded daemon that serves this cluster', async () => {
    assertHomeIsSandboxed();
    const p = await freePort();
    const cfg = config(home, p);
    const { deps, ours, spawned } = fakeDeps();
    await listen(p);
    ours.add(p);
    writePidFile(cfg, process.pid, p);

    assert.equal(await ensureRunning(cfg, deps), p);
    assert.equal(spawned.length, 0);
  });

  it('does not reuse a recorded port that a different Postgres answers on', async () => {
    // The Teleport case: the pidfile's process is alive and something is
    // listening on its port, but it is not this cluster.
    assertHomeIsSandboxed();
    const p = await freePort();
    const cfg = config(home, p);
    const { deps, spawned } = fakeDeps();
    await listen(p);
    writePidFile(cfg, process.pid, p);

    const port = await ensureRunning(cfg, deps);

    assert.equal(spawned.length, 1);
    assert.notEqual(port, p);
    assert.equal(readPidFile(cfg)?.port, port);
  });

  it('starts pgserve in single-process mode', async () => {
    assertHomeIsSandboxed();
    const cfg = config(home, await freePort());
    const { deps, spawned } = fakeDeps();
    await ensureRunning(cfg, deps);
    assert.ok(spawned[0].includes('--no-cluster'), `args: ${spawned[0].join(' ')}`);
  });

  it('fails fast with the log tail when pgserve exits before it is ready', async () => {
    assertHomeIsSandboxed();
    const cfg = config(home, await freePort());
    cfg.startupTimeoutMs = 20_000;
    const { deps } = fakeDeps({
      spawnPgserve(_args, logFd) {
        fs.writeSync(logFd, 'FATAL:  lock file "postmaster.pid" already exists\n');
        return { pid: process.pid, exitStatus: () => 'code 1' };
      },
    });

    const started = Date.now();
    await assert.rejects(ensureRunning(cfg, deps), /lock file "postmaster.pid" already exists/);
    assert.ok(Date.now() - started < 3000, 'did not wait out the startup timeout');
    assert.equal(readPidFile(cfg), null);
  });

  it('trims an oversized pgserve.log before starting', async () => {
    assertHomeIsSandboxed();
    const cfg = config(home, await freePort());
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const log = path.join(cfg.dataDir, 'pgserve.log');
    fs.writeFileSync(log, Buffer.alloc(11 * 1024 * 1024, 'x\n'));

    await ensureRunning(cfg, fakeDeps().deps);

    assert.ok(fs.statSync(log).size < 2 * 1024 * 1024, `log is ${fs.statSync(log).size} bytes`);
  });

  it('stops an orphaned Postgres that still holds the cluster', async () => {
    assertHomeIsSandboxed();
    const cfg = config(home, await freePort());
    const orphan = sleeper();
    writePostmasterPid(cfg, orphan.pid!, 6434);
    const { deps, spawned } = fakeDeps({
      async probe(port, via) {
        if (via === 'postmaster' && port === 6434) return 'ours';
        return (await canBind(port)) ? 'down' : 'ours';
      },
      processInfo: (pid) => (pid === orphan.pid ? { ppid: 1, command: 'postgres -D cluster' } : null),
    });

    await ensureRunning(cfg, deps);

    assert.equal(alive(orphan.pid!), false, 'orphaned postgres was stopped');
    assert.equal(spawned.length, 1);
  });

  it("leaves a live process alone when it is not this cluster's Postgres", async () => {
    // postmaster.pid can outlive its Postgres, and the PID can be reused by
    // an unrelated process. Only a Postgres that proves it serves this
    // cluster may be stopped.
    assertHomeIsSandboxed();
    const cfg = config(home, await freePort());
    const unrelated = sleeper();
    writePostmasterPid(cfg, unrelated.pid!, 6434);
    const { deps } = fakeDeps({
      async probe(port, via) {
        if (via === 'postmaster') return 'down';
        return (await canBind(port)) ? 'down' : 'ours';
      },
    });

    await ensureRunning(cfg, deps);

    assert.equal(alive(unrelated.pid!), true);
  });

  it('stops a stuck pgserve that owns the cluster Postgres', async () => {
    // An old cluster-mode pgserve whose workers could never bind stays alive
    // forever, holding its Postgres and writing to the log.
    assertHomeIsSandboxed();
    const cfg = config(home, await freePort());
    const pgserve = sleeper();
    const postmaster = sleeper();
    writePostmasterPid(cfg, postmaster.pid!, 6434);
    const { deps } = fakeDeps({
      async probe(port, via) {
        if (via === 'postmaster' && port === 6434) return 'ours';
        return (await canBind(port)) ? 'down' : 'ours';
      },
      processInfo: (pid) => {
        if (pid === postmaster.pid) return { ppid: pgserve.pid!, command: 'postgres -D cluster' };
        if (pid === pgserve.pid) return { ppid: 1, command: 'bun /x/node_modules/pgserve/bin/postgres-server.js' };
        return null;
      },
    });

    await ensureRunning(cfg, deps);

    assert.equal(alive(pgserve.pid!), false, 'stuck pgserve was stopped');
    assert.equal(alive(postmaster.pid!), false, 'its postgres was stopped');
  });

  it('stops the Postgres right away when its pgserve dies without stopping it', async () => {
    // A cluster-mode pgserve stuck waiting for its workers never installs
    // its shutdown handler, so SIGTERM kills it and leaves its Postgres
    // running. Waiting out the stop timeout for that Postgres is pointless.
    assertHomeIsSandboxed();
    const cfg = config(home, await freePort());
    const pgserve = sleeper();
    const postmaster = sleeper();
    writePostmasterPid(cfg, postmaster.pid!, 6434);
    const { deps } = fakeDeps({
      stopTimeoutMs: 10_000,
      async probe(port, via) {
        if (via === 'postmaster' && port === 6434) return 'ours';
        return (await canBind(port)) ? 'down' : 'ours';
      },
      processInfo: (pid) => {
        if (pid === postmaster.pid) return { ppid: pgserve.pid!, command: 'postgres -D cluster' };
        if (pid === pgserve.pid) return { ppid: 1, command: 'bun /x/node_modules/pgserve/bin/postgres-server.js' };
        return null;
      },
    });

    const started = Date.now();
    await ensureRunning(cfg, deps);

    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
    assert.equal(alive(postmaster.pid!), false);
  });

  it('starts only one daemon when two calls race', async () => {
    assertHomeIsSandboxed();
    const cfg = config(home, await freePort());
    const { deps, spawned } = fakeDeps({}, { readyAfterMs: 300 });

    const [a, b] = await Promise.all([ensureRunning({ ...cfg }, deps), ensureRunning({ ...cfg }, deps)]);

    assert.equal(spawned.length, 1);
    assert.equal(a, b);
  });
});
