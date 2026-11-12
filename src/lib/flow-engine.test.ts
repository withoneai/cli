import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, evaluateExpression } from './flow-engine.js';
import type { FlowContext, StepResult } from './flow-types.js';

// Regression coverage for #89: step-level `if`/`unless` (and `while` /
// `condition` steps) must not crash when a condition references a skipped or
// not-yet-produced step output. A missing upstream value makes the condition
// false instead of throwing "Cannot read properties of undefined".

function ctx(steps: Record<string, StepResult> = {}): FlowContext {
  return { input: {}, env: {}, steps, loop: {} };
}

describe('evaluateCondition — null-safe condition evaluation (#89)', () => {
  it('returns false when referencing the output of a skipped step (no output key)', async () => {
    // Exactly the #89 repro: stepA was skipped, so it has { status: 'skipped' }
    // with no `output`. stepB's `if` reads $.steps.stepA.output.result.
    const context = ctx({ stepA: { status: 'skipped' } });
    assert.equal(await evaluateCondition('$.steps.stepA.output.result', context), false);
  });

  it('returns false when referencing a step that never ran at all', async () => {
    assert.equal(await evaluateCondition('$.steps.neverRan.output.value === true', ctx()), false);
  });

  it('returns false for deep access through several missing segments', async () => {
    assert.equal(await evaluateCondition('$.steps.a.output.b.c.d', ctx()), false);
  });

  it('still evaluates truthy/falsy correctly when the value is present', async () => {
    const context = ctx({ stepA: { status: 'success', output: { result: 'hello' } } });
    assert.equal(await evaluateCondition('$.steps.stepA.output.result', context), true);
    assert.equal(await evaluateCondition("$.steps.stepA.output.result === 'hello'", context), true);
    assert.equal(await evaluateCondition("$.steps.stepA.output.result === 'nope'", context), false);
  });

  it('coerces non-boolean truthy results to a real boolean', async () => {
    const context = ctx({ s: { status: 'success', output: { n: 0, str: 'x' } } });
    assert.strictEqual(await evaluateCondition('$.steps.s.output.n', context), false);
    assert.strictEqual(await evaluateCondition('$.steps.s.output.str', context), true);
  });

  it('reads input/env without crashing', async () => {
    const context: FlowContext = { input: { flag: true }, env: { X: '1' }, steps: {}, loop: {} };
    assert.equal(await evaluateCondition('$.input.flag', context), true);
    assert.equal(await evaluateCondition('$.input.missing', context), false);
  });

  it('rethrows genuine syntax errors (does not swallow malformed expressions)', async () => {
    await assert.rejects(evaluateCondition('$.steps.a.output.(', ctx()), SyntaxError);
  });

  it('rethrows reference errors for unknown bare identifiers', async () => {
    await assert.rejects(evaluateCondition('someUndefinedGlobal === 1', ctx()), ReferenceError);
  });

  it('leaves evaluateExpression (transforms) throwing on undefined access', async () => {
    // Transforms must still fail loudly — their output feeds downstream steps.
    await assert.rejects(evaluateExpression('$.steps.gone.output.x', ctx()), TypeError);
  });
});
