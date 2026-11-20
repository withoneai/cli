import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeFlow } from './flow-engine.js';
import type { OneApi } from './api.js';
import type { Flow, FlowEvent, FlowStep } from './flow-types.js';

// `flow execute --mock` mocked action, paginate and bash steps but ran
// file-write for real, so a "mock" run still created or overwrote files.

const fakeApi = {} as unknown as OneApi;

function flowOf(steps: FlowStep[]): Flow {
  return { key: 'test', name: 'Test', version: '1', inputs: {}, steps } as unknown as Flow;
}

describe('flow --mock and file-write', () => {
  let dir: string;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mock-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const writeStep = (file: string, append = false) => ({
    id: 'save',
    name: 'Save',
    type: 'file-write',
    fileWrite: { path: file, content: { hello: 'world' }, ...(append ? { append: true } : {}) },
  }) as unknown as FlowStep;

  it('does not create the file', async () => {
    const file = path.join(dir, 'nested', 'out.json');
    const events: FlowEvent[] = [];
    const context = await executeFlow(flowOf([writeStep(file)]), {}, fakeApi, 'write', [], {
      mock: true,
      onEvent: e => events.push(e),
    });
    assert.equal(fs.existsSync(file), false, 'mock run must not write the file');
    assert.equal(fs.existsSync(path.dirname(file)), false, 'mock run must not create parent dirs');
    const out = context.steps.save.output as Record<string, unknown>;
    assert.equal(out.path, path.resolve(file));
    assert.equal(out.bytesWritten, JSON.stringify({ hello: 'world' }, null, 2).length);
    assert.equal(out._mock, true);
    assert.ok(events.some(e => e.event === 'step:mock' && e.stepId === 'save'));
  });

  it('leaves an existing file untouched, appending or not', async () => {
    const file = path.join(dir, 'existing.txt');
    fs.writeFileSync(file, 'original');
    await executeFlow(flowOf([writeStep(file)]), {}, fakeApi, 'write', [], { mock: true });
    await executeFlow(flowOf([writeStep(file, true)]), {}, fakeApi, 'write', [], { mock: true });
    assert.equal(fs.readFileSync(file, 'utf-8'), 'original');
  });

  it('still writes for real without --mock', async () => {
    const file = path.join(dir, 'real.json');
    await executeFlow(flowOf([writeStep(file)]), {}, fakeApi, 'write', [], {});
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { hello: 'world' });
  });
});
