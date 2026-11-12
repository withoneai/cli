import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateExpression, executeFlow } from './flow-engine.js';
import { spawnSync } from 'node:child_process';
import { SANDBOX_NODE_FLAGS, sandboxEnv, sandboxRunCode, setSandboxTimeouts, stopSandbox } from './flow-sandbox.js';
import type { OneApi } from './api.js';
import type { Flow, FlowContext, FlowStep } from './flow-types.js';

// PICA-1560: flow files are untrusted input. Their inline JavaScript
// (transforms, conditions, if/unless guards, code.source) must not be able
// to start programs, touch files or read the CLI's environment, and
// code.module steps (full Node) must need --allow-code.

const fakeApi = {} as unknown as OneApi;

function ctx(over: Partial<FlowContext> = {}): FlowContext {
  return { input: {}, env: {}, steps: {}, loop: {}, ...over };
}

function flowOf(steps: FlowStep[]): Flow {
  return { key: 'sandbox-test', name: 'Sandbox test', version: '1', inputs: {}, steps } as unknown as Flow;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-flow-sandbox-'));
after(() => {
  stopSandbox();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('flow sandbox — what flow JavaScript cannot reach', () => {
  it('has no process, require, fetch or timers in scope', async () => {
    const r = await evaluateExpression(
      '[typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.process]',
      ctx(),
    );
    assert.deepEqual(r, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('blocks the audit payload: process.getBuiltinModule child_process', async () => {
    const marker = path.join(tmp, 'pwned-transform');
    const expr = `process.getBuiltinModule('child_process').execSync('touch ${marker}')`;
    await assert.rejects(evaluateExpression(expr, ctx()), /process is not defined/);
    assert.equal(fs.existsSync(marker), false);
  });

  it('blocks the Function-constructor escape through a value in $', async () => {
    await assert.rejects(
      evaluateExpression(`$.input.constructor.constructor('return process')()`, ctx({ input: { a: 1 } })),
      /Code generation from strings disallowed/,
    );
    await assert.rejects(evaluateExpression(`eval('1 + 1')`, ctx()), /Code generation from strings disallowed/);
  });

  it('code.source: blocked modules still throw, allowed ones still work', async () => {
    await assert.rejects(
      sandboxRunCode(`const cp = await require('child_process'); return cp;`, ctx(), 'code:t1'),
      /Module "child_process" is blocked in code steps/,
    );
    const hash = await sandboxRunCode(
      `const c = await require('crypto'); return c.createHash('sha256').update($.input.s).digest('hex');`,
      ctx({ input: { s: 'abc' } }),
      'code:t2',
    );
    assert.equal(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('the sandbox process itself cannot read files, start programs or see env (boundary under the JS layer)', () => {
    // Runs plain Node code under the sandbox's flags, with process and
    // require still present, to prove the boundary holds even if the global
    // stripping were bypassed.
    const secret = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    const probe = `
      const out = {};
      try { require('fs').readFileSync(${JSON.stringify(secret)}, 'utf8'); out.read = 'allowed'; } catch (e) { out.read = e.code; }
      try { require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'w'))}, 'x'); out.write = 'allowed'; } catch (e) { out.write = e.code; }
      try { require('child_process').execFileSync(process.execPath, ['-v']); out.spawn = 'allowed'; } catch (e) { out.spawn = e.code; }
      try { new (require('worker_threads').Worker)('1', { eval: true }); out.worker = 'allowed'; } catch (e) { out.worker = e.code; }
      out.secret = process.env.ONE_SECRET === undefined ? 'absent' : 'present';
      console.log(JSON.stringify(out));
    `;
    const r = spawnSync(process.execPath, [...SANDBOX_NODE_FLAGS.filter(f => f === '--permission'), '-e', probe], {
      env: sandboxEnv(), encoding: 'utf8',
    });
    const out = JSON.parse(r.stdout.trim());
    assert.deepEqual(out, {
      read: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED',
      worker: 'ERR_ACCESS_DENIED', secret: 'absent',
    });
    assert.equal(fs.existsSync(path.join(tmp, 'w')), false);
  });

  it('a transform step in a flow cannot write a file, and the flow fails', async () => {
    const marker = path.join(tmp, 'pwned-flow');
    const flow = flowOf([
      { id: 'evil', name: 'Evil', type: 'transform', transform: {
        expression: `process.getBuiltinModule('fs').writeFileSync('${marker}', 'x')`,
      } } as unknown as FlowStep,
    ]);
    await assert.rejects(executeFlow(flow, {}, fakeApi, 'write', [], {}));
    assert.equal(fs.existsSync(marker), false);
  });

  it('a code.source step cannot start a program, and the flow fails', async () => {
    const marker = path.join(tmp, 'pwned-code');
    const flow = flowOf([
      { id: 'evil', name: 'Evil', type: 'code', code: {
        source: `return process.getBuiltinModule('child_process').execSync('touch ${marker}');`,
      } } as unknown as FlowStep,
    ]);
    await assert.rejects(executeFlow(flow, {}, fakeApi, 'write', [], {}), /process is not defined/);
    assert.equal(fs.existsSync(marker), false);
  });

  it('if/unless guards run in the sandbox too', async () => {
    const marker = path.join(tmp, 'pwned-guard');
    const flow = flowOf([
      { id: 'g', name: 'G', type: 'transform', if: `process.getBuiltinModule('fs').writeFileSync('${marker}', 'x') || true`,
        transform: { expression: '1' } } as unknown as FlowStep,
    ]);
    await assert.rejects(executeFlow(flow, {}, fakeApi, 'write', [], {}));
    assert.equal(fs.existsSync(marker), false);
  });
});

describe('flow sandbox — normal flows keep working', () => {
  it('evaluates transforms against $ and returns rich values', async () => {
    const r = await evaluateExpression(
      `({ n: $.steps.a.output.items.length, d: new Date(0), m: new Map([['k', 1]]), u: undefined })`,
      ctx({ steps: { a: { status: 'success', output: { items: [1, 2, 3] } } } }),
    );
    const v = r as { n: number; d: Date; m: Map<string, number>; u: undefined };
    assert.equal(v.n, 3);
    assert.ok(v.d instanceof Date);
    assert.equal(v.d.getTime(), 0);
    assert.ok(v.m instanceof Map);
    assert.equal(v.m.get('k'), 1);
    assert.ok('u' in v);
  });

  it('a multi-step flow with transform, condition and code.source runs', async () => {
    const flow = flowOf([
      { id: 'nums', name: 'Nums', type: 'transform', transform: { expression: '[1, 2, 3, 4]' } },
      { id: 'big', name: 'Big', type: 'condition', condition: {
        expression: '$.steps.nums.output.length > 2',
        then: [{ id: 'sum', name: 'Sum', type: 'code', code: { source: 'return $.steps.nums.output.reduce((a, b) => a + b, 0);' } }],
      } },
    ] as unknown as FlowStep[]);
    const context = await executeFlow(flow, {}, fakeApi, 'write', [], {});
    assert.equal(context.steps.sum.output, 10);
  });

  it('keeps user-relative line numbers in code step errors', async () => {
    const flow = flowOf([
      { id: 'blowup', name: 'Blow up', type: 'code', code: { source: 'const a = 1;\nconst b = null;\nreturn b.score;' } },
    ] as unknown as FlowStep[]);
    await assert.rejects(executeFlow(flow, {}, fakeApi, 'write', [], {}), (err: Error) => {
      assert.match(err.message, /Code step "blowup" failed at line 3:/);
      assert.match(err.message, /return b\.score;/);
      return true;
    });
  });

  it('fails clearly when a step returns a function', async () => {
    await assert.rejects(evaluateExpression('() => 1', ctx()), /cannot be copied out of the sandbox/);
  });
});

describe('flow sandbox — the cached copy of $ stays in step with the flow', () => {
  it('sees replaced steps, new loop values and removed steps, and keeps contexts apart', async () => {
    const a = ctx({ input: { who: 'a' }, steps: { s: { status: 'success', output: 1 } } });
    const b = ctx({ input: { who: 'b' } });
    assert.equal(await evaluateExpression('$.steps.s.output', a), 1);
    a.steps.s = { status: 'success', output: 2 };
    assert.equal(await evaluateExpression('$.steps.s.output', a), 2);
    a.loop = { item: 'x', i: 0 };
    assert.equal(await evaluateExpression('$.loop.item', a), 'x');
    // A sub-flow has its own context: it must not see the parent's steps.
    assert.deepEqual(await evaluateExpression('[$.input.who, $.steps.s]', b), ['b', undefined]);
    assert.deepEqual(await evaluateExpression('[$.input.who, $.steps.s.output]', a), ['a', 2]);
    delete a.steps.s;
    assert.equal(await evaluateExpression('$.steps.s', a), undefined);
  });
});

describe('flow sandbox — time limit', () => {
  it('stops a runaway expression and recovers for the next call', async () => {
    setSandboxTimeouts(200, 2_000);
    try {
      await assert.rejects(evaluateExpression('(() => { while (true) {} })()', ctx()), /timed out/);
      assert.equal(await evaluateExpression('1 + 1', ctx()), 2);
      await assert.rejects(
        sandboxRunCode('await new Promise(() => {}); return 1;', ctx(), 'code:hang'),
        /timed out/,
      );
      assert.equal(await evaluateExpression('2 + 2', ctx()), 4);
    } finally {
      setSandboxTimeouts(30_000, 60_000);
    }
  });
});

describe('code.module requires --allow-code', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'flowroot-'));
  fs.mkdirSync(path.join(root, 'lib'));
  const marker = path.join(root, 'module-ran');
  fs.writeFileSync(
    path.join(root, 'lib', 'mod.mjs'),
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\nconsole.log(JSON.stringify({ ok: true }));\n`,
  );
  const flow = flowOf([
    { id: 'm', name: 'Module', type: 'code', code: { module: 'lib/mod.mjs' } } as unknown as FlowStep,
  ]);

  it('refuses to run the module without allowCode', async () => {
    await assert.rejects(
      executeFlow(flow, {}, fakeApi, 'write', [], { rootDir: root }),
      /requires the --allow-code flag/,
    );
    assert.equal(fs.existsSync(marker), false);
  });

  it('runs it with allowCode', async () => {
    const context = await executeFlow(flow, {}, fakeApi, 'write', [], { rootDir: root, allowCode: true });
    assert.deepEqual(context.steps.m.output, { ok: true });
    assert.equal(fs.existsSync(marker), true);
  });
});
