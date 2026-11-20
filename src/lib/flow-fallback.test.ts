import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeFlow } from './flow-engine.js';
import { validateFlowSchema } from './flow-validator.js';
import type { OneApi } from './api.js';
import type { Flow, FlowEvent, FlowStep } from './flow-types.js';

// `onError: { strategy: "fallback", fallbackStepId }` never ran the fallback
// step: the failure was recorded and the run moved on, like `continue`. A
// fallback step only ran because of where it sat in the list, so it also ran
// when the primary succeeded.

const fakeApi = {} as unknown as OneApi;

const transform = (id: string, expression = `'${id}'`): FlowStep =>
  ({ id, name: id, type: 'transform', transform: { expression } }) as unknown as FlowStep;
const code = (id: string, source: string, extra: Record<string, unknown> = {}): FlowStep =>
  ({ id, name: id, type: 'code', code: { source }, ...extra }) as unknown as FlowStep;
const withFallback = (target: string) => ({ onError: { strategy: 'fallback', fallbackStepId: target } });

const flowOf = (steps: FlowStep[]): Flow =>
  ({ key: 'fb', name: 'Fallback', version: '1', inputs: {}, steps }) as unknown as Flow;

async function run(steps: FlowStep[]) {
  const events: FlowEvent[] = [];
  const context = await executeFlow(flowOf(steps), {}, fakeApi, 'write', [], { onEvent: e => events.push(e) });
  const started = events.filter(e => e.event === 'step:start').map(e => e.stepId);
  return { context, events, started };
}

describe('onError fallback', () => {
  it('runs the fallback step when the step fails', async () => {
    const { context, events, started } = await run([
      code('primary', "throw new Error('down')", withFallback('backup')),
      transform('backup'),
      transform('after'),
    ]);
    assert.deepEqual(started, ['primary', 'backup', 'after']);
    assert.equal(context.steps.primary.status, 'failed');
    assert.equal(context.steps.backup.status, 'success');
    assert.ok(events.some(e => e.event === 'step:fallback' && e.stepId === 'primary' && e.fallbackStepId === 'backup'));
  });

  it('skips the fallback step when the step succeeds', async () => {
    const { context, started } = await run([
      code('primary', "return 'ok'", withFallback('backup')),
      transform('backup'),
      transform('after'),
    ]);
    assert.deepEqual(started, ['primary', 'after']);
    assert.equal(context.steps.backup, undefined);
  });

  it('runs the fallback even when it is listed before the step', async () => {
    const { started } = await run([
      transform('backup'),
      code('primary', "throw new Error('down')", withFallback('backup')),
    ]);
    assert.deepEqual(started, ['primary', 'backup']);
  });

  it('fails the flow when the fallback step fails too', async () => {
    await assert.rejects(
      run([code('primary', "throw new Error('down')", withFallback('backup')), code('backup', "throw new Error('also down')")]),
      /also down/,
    );
  });

  it('works inside a parallel block', async () => {
    const { context } = await run([
      {
        id: 'par', name: 'par', type: 'parallel',
        parallel: { steps: [code('primary', "throw new Error('down')", withFallback('backup')), transform('backup'), transform('other')] },
      } as unknown as FlowStep,
    ]);
    assert.equal(context.steps.primary.status, 'failed');
    assert.equal(context.steps.backup.status, 'success');
    assert.equal(context.steps.other.status, 'success');
  });
});

describe('validator: fallback', () => {
  const errorsFor = (steps: FlowStep[], extra: Record<string, unknown> = {}) =>
    validateFlowSchema({ ...flowOf(steps), ...extra }).map(e => e.message).join('\n');

  it('accepts a fallback to a sibling step', () => {
    assert.equal(errorsFor([code('primary', 'return 1', withFallback('backup')), transform('backup')]), '');
  });
  it('requires fallbackStepId', () => {
    assert.match(errorsFor([code('primary', 'return 1', { onError: { strategy: 'fallback' } })]), /fallbackStepId/);
  });
  it('rejects a fallback that is not a sibling', () => {
    assert.match(errorsFor([code('primary', 'return 1', withFallback('nowhere')), transform('backup')]), /nowhere/);
  });
  it('rejects a step that falls back to itself', () => {
    assert.match(errorsFor([code('primary', 'return 1', withFallback('primary'))]), /itself/);
  });
  it('rejects fallback in defaultOnError', () => {
    assert.match(
      errorsFor([transform('a')], { defaultOnError: { strategy: 'fallback', fallbackStepId: 'a' } }),
      /defaultOnError/,
    );
  });
});
