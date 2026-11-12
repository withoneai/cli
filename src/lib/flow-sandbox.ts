/**
 * Sandbox for the JavaScript that flow files carry inline: `transform`
 * expressions, `condition`/`while` expressions, `if`/`unless` guards and
 * `code.source` bodies.
 *
 * A flow file can come from anywhere (a cloned repo, a shared folder, an
 * agent), so its JavaScript must not be able to start programs, touch files
 * or read the CLI's environment. Running it with `new Function` in the CLI
 * process gave it all of that (`process.getBuiltinModule('child_process')`).
 *
 * Instead it runs in one long-lived child `node` process per CLI run:
 *
 *   - `--permission`: Node's permission model. No child processes, no
 *     worker threads, no native addons, no file reads or writes. This is the
 *     boundary; everything below is defence in depth.
 *   - `env: {}`: the child gets no environment of its own (no API keys,
 *     tokens or NODE_OPTIONS). The flow's `$.env` is still passed in as part
 *     of `$`, as before.
 *   - `--disallow-code-generation-from-strings`: `eval` / `Function(...)`
 *     throw, so the usual `x.constructor.constructor('return ...')` trick has
 *     nothing to compile.
 *   - Before any flow code runs, the bootstrap deletes `process`, `require`,
 *     `fetch`, `WebSocket`, timers and friends from the child's global scope.
 *   - Every evaluation has a time limit; a hung one kills the child, which is
 *     respawned on the next call.
 *
 * Values cross the boundary with the structured-clone algorithm (IPC
 * `serialization: 'advanced'`), so `Date`, `Map`, `Set`, `RegExp`, typed
 * arrays and `undefined` survive. Functions and symbols cannot be copied;
 * returning one fails the step with a clear message. `$` is a copy: a code
 * step that mutates `$` no longer changes the flow's context (it never was a
 * supported way to pass data — return a value instead).
 *
 * `code.module` steps are NOT run here. They are separate `.mjs` files with
 * full Node access, and are gated behind `--allow-code`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { FlowContext } from './flow-types.js';

/** Synchronous time limit for one expression or code body. */
let syncTimeoutMs = 30_000;
/** Overall limit for one call, including an async `code.source` body. */
let callTimeoutMs = 60_000;

/** Node flags for the sandbox process. Exported so tests can probe the boundary on its own. */
export const SANDBOX_NODE_FLAGS = ['--permission', '--disallow-code-generation-from-strings'] as const;

/**
 * The sandbox's own environment: empty. Windows needs SystemRoot for some
 * core APIs (crypto, DNS) to initialise, and it holds no secrets.
 */
export function sandboxEnv(): Record<string, string> {
  if (process.platform === 'win32' && process.env.SystemRoot) return { SystemRoot: process.env.SystemRoot };
  return {};
}

// Runs inside the child via `node -e`, so the sandbox needs no file of its
// own on disk (and no fs read permission to load one). Plain JS, no TS.
const BOOTSTRAP = String.raw`
'use strict';
const vm = require('node:vm');
const proc = process;
const MODULES = {
  buffer: require('node:buffer'),
  crypto: require('node:crypto'),
  url: require('node:url'),
  path: require('node:path'),
};
const BLOCKED = new Set(['fs', 'http', 'https', 'net', 'child_process', 'process', 'os',
  'cluster', 'dgram', 'tls', 'vm', 'worker_threads']);
const sandboxRequire = async (name) => {
  const clean = String(name).replace(/^node:/, '');
  if (BLOCKED.has(clean)) throw new Error('Module "' + name + '" is blocked in code steps');
  if (!Object.prototype.hasOwnProperty.call(MODULES, clean)) {
    throw new Error('Module "' + name + '" not available. Allowed: ' + Object.keys(MODULES).join(', '));
  }
  return MODULES[clean];
};
const SYNC_TIMEOUT = Number(proc.argv[proc.argv.length - 1]) || 30000;
const send = proc.send.bind(proc);

for (const k of ['process', 'require', 'module', 'exports', '__filename', '__dirname',
  'fetch', 'WebSocket', 'EventSource', 'Request', 'Response', 'Headers', 'FormData',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
  'clearImmediate', 'navigator', 'global']) {
  try { delete globalThis[k]; } catch (_) { /* non-configurable: leave it */ }
}

const describe = (err) => {
  if (err && typeof err === 'object') {
    return { name: String(err.name || 'Error'), message: String(err.message), stack: String(err.stack || '') };
  }
  return { name: 'Error', message: String(err), stack: '' };
};

const reply = (id, value) => {
  try {
    send({ id, ok: true, value });
  } catch (err) {
    send({ id, ok: false, error: { name: 'Error', stack: '', message:
      'returned a value that cannot be copied out of the sandbox (functions, symbols and class instances with private state cannot be passed between steps): ' + (err && err.message) } });
  }
};

// The sandbox's copy of $. The host sends only the parts that changed since
// the last call (see syncFor in flow-sandbox.ts), so a loop over a large
// step output doesn't copy that output again on every iteration.
let store = { input: {}, env: {}, steps: {}, loop: {} };
const applySync = (sync) => {
  if (sync.reset) store = { input: {}, env: {}, steps: {}, loop: {} };
  if ('input' in sync) store.input = sync.input;
  if ('env' in sync) store.env = sync.env;
  if ('loop' in sync) store.loop = sync.loop;
  if (sync.steps) for (const k of Object.keys(sync.steps)) store.steps[k] = sync.steps[k];
  if (sync.drop) for (const k of sync.drop) delete store.steps[k];
};

proc.on('message', async (msg) => {
  const { id, kind, code, sync, filename } = msg;
  try {
    applySync(sync);
    globalThis.__one_ctx = store;
    globalThis.__one_require = sandboxRequire;
    let value;
    if (kind === 'expr') {
      const script = new vm.Script('(function ($) { return (' + code + '\n) })(__one_ctx)', { filename: filename || 'expression' });
      value = script.runInThisContext({ timeout: SYNC_TIMEOUT });
    } else {
      // Same wrapper shape as new AsyncFunction('$', 'require', body), so
      // stack line numbers are offset by exactly 2, as the engine expects.
      const script = new vm.Script('(async function anonymous($,require\n) {\n' + code + '\n})(__one_ctx, __one_require)', { filename });
      value = await script.runInThisContext({ timeout: SYNC_TIMEOUT });
    }
    reply(id, value);
  } catch (err) {
    send({ id, ok: false, error: describe(err) });
  } finally {
    delete globalThis.__one_ctx;
    delete globalThis.__one_require;
  }
});
send({ ready: true });
`;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  proc: ChildProcess;
}

let child: ChildProcess | null = null;
let ready: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

const ERROR_CTORS: Record<string, ErrorConstructor> = {
  TypeError, SyntaxError, ReferenceError, RangeError, EvalError, URIError,
};

function rebuildError(e: { name: string; message: string; stack: string }): Error {
  const Ctor = ERROR_CTORS[e.name] ?? Error;
  const err = new Ctor(e.message);
  if (!ERROR_CTORS[e.name] && e.name && e.name !== 'Error') err.name = e.name;
  if (e.stack) err.stack = e.stack;
  return err;
}

function setRef(on: boolean): void {
  if (!child) return;
  const channel = (child as ChildProcess & { channel?: { ref(): void; unref(): void } }).channel;
  if (on) { child.ref(); channel?.ref(); } else { child.unref(); channel?.unref(); }
}

function failAll(proc: ChildProcess, err: Error): void {
  for (const [id, p] of pending) {
    if (p.proc !== proc) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(err);
  }
}

function start(): Promise<void> {
  if (ready) return ready;
  const proc = spawn(
    process.execPath,
    [...SANDBOX_NODE_FLAGS, '-e', BOOTSTRAP, '--', String(syncTimeoutMs)],
    {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'advanced',
      env: sandboxEnv(),
      windowsHide: true,
    },
  );
  child = proc;
  ready = new Promise<void>((resolve, reject) => {
    const onReady = (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { ready?: boolean }).ready) {
        proc.off('message', onReady);
        resolve();
      }
    };
    proc.on('message', onReady);
    proc.once('error', err => reject(new Error(`Could not start the flow code sandbox: ${err.message}`)));
    proc.once('exit', (code, signal) => {
      reject(new Error(`Flow code sandbox exited before it was ready (code ${code}, signal ${signal})`));
    });
  });
  proc.on('message', (msg: { id?: number; ok?: boolean; value?: unknown; error?: { name: string; message: string; stack: string } }) => {
    if (typeof msg?.id !== 'number') return;
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (pending.size === 0) setRef(false);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(rebuildError(msg.error ?? { name: 'Error', message: 'unknown sandbox error', stack: '' }));
  });
  proc.on('exit', (code, signal) => {
    if (child === proc) { child = null; ready = null; }
    failAll(proc, new Error(`Flow code sandbox stopped (code ${code}, signal ${signal})`));
  });
  proc.on('error', err => {
    if (child === proc) { child = null; ready = null; }
    failAll(proc, err);
  });
  return ready;
}

/**
 * What the sandbox already holds, so each call sends only what changed.
 * Compared by reference: the engine replaces `context.steps[id]` and
 * `context.loop` with new objects rather than editing them in place.
 */
interface SyncState {
  proc: ChildProcess;
  context: FlowContext;
  stepsObj: FlowContext['steps'];
  input: unknown;
  env: unknown;
  loop: unknown;
  steps: Map<string, unknown>;
}
let synced: SyncState | null = null;

/** Build the update for `context` and the bookkeeping to commit once it is sent. */
function syncFor(proc: ChildProcess, context: FlowContext): { sync: Record<string, unknown>; commit: () => void } {
  const prev = synced && synced.proc === proc && synced.context === context && synced.stepsObj === context.steps
    ? synced : null;
  const sync: Record<string, unknown> = {};
  if (!prev) sync.reset = true;
  if (!prev || prev.input !== context.input) sync.input = context.input;
  if (!prev || prev.env !== context.env) sync.env = context.env;
  if (!prev || prev.loop !== context.loop) sync.loop = context.loop;
  const stepUpdates: Record<string, unknown> = {};
  let anyStep = false;
  const nextSteps = new Map<string, unknown>();
  for (const [k, v] of Object.entries(context.steps)) {
    nextSteps.set(k, v);
    if (!prev || prev.steps.get(k) !== v) { stepUpdates[k] = v; anyStep = true; }
  }
  if (anyStep) sync.steps = stepUpdates;
  if (prev) {
    const drop = [...prev.steps.keys()].filter(k => !nextSteps.has(k));
    if (drop.length) sync.drop = drop;
  }
  const commit = () => {
    synced = {
      proc, context, stepsObj: context.steps,
      input: context.input, env: context.env, loop: context.loop, steps: nextSteps,
    };
  };
  return { sync, commit };
}

async function call(kind: 'expr' | 'code', code: string, context: FlowContext, filename: string): Promise<unknown> {
  await start();
  const proc = child!;
  const id = nextId++;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out after ${callTimeoutMs / 1000}s`));
      // The child may be stuck in a never-settling promise; replace it.
      // Drop the handle now so the next call starts a fresh process instead
      // of queueing on this one while it dies.
      if (child === proc) { child = null; ready = null; }
      proc.kill();
    }, callTimeoutMs);
    timer.unref();
    pending.set(id, { resolve, reject, timer, proc });
    setRef(true);
    const { sync, commit } = syncFor(proc, context);
    try {
      proc.send({ id, kind, code, sync, filename });
      commit();
    } catch (err) {
      // Nothing was sent; make the next call start from a clean copy.
      synced = null;
      clearTimeout(timer);
      pending.delete(id);
      if (pending.size === 0) setRef(false);
      reject(new Error(
        `the flow context contains a value that cannot be passed to the sandbox: ${(err as Error).message}`,
      ));
    }
  });
}

/** Evaluate a flow expression (`transform`, `condition`, `while`, `if`/`unless`) in the sandbox. */
export function sandboxEvaluate(expr: string, context: FlowContext): Promise<unknown> {
  return call('expr', expr, context, 'expression');
}

/** Run an inline `code.source` body in the sandbox. `filename` tags stack frames. */
export function sandboxRunCode(source: string, context: FlowContext, filename: string): Promise<unknown> {
  return call('code', source, context, filename);
}

/** Change the time limits (tests). Restarts the sandbox on its next use. */
export function setSandboxTimeouts(syncMs: number, callMs: number): void {
  syncTimeoutMs = syncMs;
  callTimeoutMs = callMs;
  stopSandbox();
}

/** Stop the sandbox process (tests; the CLI just exits). */
export function stopSandbox(): void {
  if (child) child.kill();
  child = null;
  ready = null;
}
