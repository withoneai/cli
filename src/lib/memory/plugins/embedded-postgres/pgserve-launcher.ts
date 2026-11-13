/**
 * Runs the embedded Postgres for the memory store. Started by daemon.ts under
 * pgserve's bundled Bun runtime, since pgserve's PostgresManager uses Bun APIs.
 *
 * This replaces pgserve's own server (`postgres-server.js`), whose TCP router
 * forwarded every client to Postgres's trust-authenticated Unix socket, so any
 * local account could log in as superuser with no password. Here clients
 * connect to Postgres directly, and its TCP port requires a per-install
 * password. The Unix socket stays trust-authenticated, but pgserve puts it in
 * a directory only this account can open.
 *
 * Usage:
 *   bun pgserve-launcher.js --data <cluster dir> --port <n> --database <name>
 *     --secrets <auth.json> --marker <file> --ready <file> [--pgvector] [--log <level>]
 *
 * `--marker` records that the cluster's superuser password is the one in
 * `--secrets`. A cluster created before this launcher existed still has
 * pgserve's default password `postgres`; it is switched on first start.
 * `--ready` gets this process's PID once the store's database is ready.
 * Postgres answers before then, and may be restarted during the switch, so
 * the CLI waits for this file rather than for Postgres.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PostgresManager } from 'pgserve';

/** pgserve's default superuser password, which older CLI versions left in place. */
const LEGACY_PASSWORD = 'postgres';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
  trace(obj: unknown, msg?: string): void;
  child(bindings: unknown): Logger;
}

function createLogger(minLevel: Level): Logger {
  const write = (level: Level) => (obj: unknown, msg?: string) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const fields = typeof obj === 'string' ? { msg: obj } : { msg, ...(obj as object) };
    const line = JSON.stringify({ time: new Date().toISOString(), level, ...fields }, (_k, v) =>
      v instanceof Error ? v.message : v);
    process.stdout.write(line + '\n');
  };
  const logger: Logger = {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('error'),
    trace: () => {},
    child: () => logger,
  };
  return logger;
}

function parseArgs(argv: string[]) {
  const value = (flag: string): string => {
    const i = argv.indexOf(flag);
    const v = i === -1 ? undefined : argv[i + 1];
    if (!v) throw new Error(`pgserve-launcher: missing ${flag}`);
    return v;
  };
  const level = (argv.includes('--log') ? value('--log') : 'warn') as Level;
  return {
    dataDir: value('--data'),
    port: Number(value('--port')),
    database: value('--database'),
    secretsFile: value('--secrets'),
    marker: value('--marker'),
    ready: value('--ready'),
    pgvector: argv.includes('--pgvector'),
    logLevel: level in LEVELS ? level : 'warn',
  };
}

/** The superuser password is hex, so it is safe inside a SQL string literal. */
function readSuperuserPassword(file: string): string {
  const { superuser } = JSON.parse(fs.readFileSync(file, 'utf8')) as { superuser?: unknown };
  if (typeof superuser !== 'string' || !/^[0-9a-f]{32,}$/.test(superuser)) {
    throw new Error(`pgserve-launcher: ${file} has no valid superuser password`);
  }
  return superuser;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger(args.logLevel);
  const secret = readSuperuserPassword(args.secretsFile);

  // Installed first: a signal during startup must still stop Postgres, or it
  // outlives this process and holds the cluster.
  let current: PostgresManager | null = null;
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await current?.stop().catch(() => {});
    process.exit(code);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => { void stop(0); });

  // A new cluster is created with the secret. An existing one has it once
  // the marker is written; until then it still has the legacy password.
  const isNew = !fs.existsSync(path.join(args.dataDir, 'PG_VERSION'));
  const expected = isNew || fs.existsSync(args.marker) ? secret : LEGACY_PASSWORD;

  const start = async (password: string) => {
    const mgr = new PostgresManager({
      dataDir: args.dataDir,
      port: args.port,
      password,
      logger,
      enablePgvector: args.pgvector,
    });
    current = mgr;
    try {
      await mgr.start();
      return mgr;
    } catch (err) {
      await mgr.stop().catch(() => {});
      throw err;
    }
  };

  let mgr: PostgresManager;
  try {
    mgr = await start(expected);
  } catch (err) {
    // The marker and the cluster disagree, e.g. a crash between changing the
    // password and writing the marker. Try the other password once.
    if (!/password authentication failed/i.test(err instanceof Error ? err.message : String(err))) throw err;
    logger.warn({}, 'Superuser password did not match the marker; retrying with the other one');
    mgr = await start(expected === secret ? LEGACY_PASSWORD : secret);
  }

  try {
    if (mgr.password !== secret) {
      await mgr.adminPool.unsafe(`ALTER ROLE postgres PASSWORD '${secret}'`);
      mgr.password = secret;
      await mgr.adminPool.close();
      await mgr._initAdminPool();
      logger.info({}, 'Replaced the default superuser password');
    }
    if (!fs.existsSync(args.marker)) fs.writeFileSync(args.marker, '', { mode: 0o600 });
    await mgr.createDatabase(args.database);
  } catch (err) {
    await mgr.stop().catch(() => {});
    throw err;
  }
  if (stopping) return;
  fs.writeFileSync(args.ready, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  logger.info({ port: args.port, database: args.database }, 'Embedded Postgres ready');
  // If Postgres dies on its own, exit too, so the next CLI call starts afresh.
  void mgr.process?.exited.then(() => {
    if (!stopping) {
      logger.error({}, 'Postgres exited unexpectedly');
      void stop(1);
    }
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`pgserve-launcher: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
