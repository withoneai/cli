import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reviveStringifiedJson } from './migrate.js';
import { getByDotPath } from '../../lib/dot-path.js';

describe('reviveStringifiedJson', () => {
  it('parses top-level JSON-stringified objects', () => {
    // Mirrors the exact legacy shape that bit Moe: Attio companies'
    // nested `id: {workspace_id, object_id, record_id}` gets
    // JSON.stringify'd on INSERT, stored as text in the `id` column,
    // and dot-path `id.record_id` needs to resolve after rehydration.
    const row = {
      id: '{"workspace_id":"ws_1","object_id":"obj_1","record_id":"rec_abc"}',
      name: 'Acme',
    };
    const out = reviveStringifiedJson(row);
    assert.deepEqual(out.id, { workspace_id: 'ws_1', object_id: 'obj_1', record_id: 'rec_abc' });
    assert.equal(getByDotPath(out, 'id.record_id'), 'rec_abc', 'dotted idField must resolve after rehydration');
  });

  it('parses top-level JSON-stringified arrays', () => {
    const row = { tags: '["urgent","billing"]', name: 'x' };
    const out = reviveStringifiedJson(row);
    assert.deepEqual(out.tags, ['urgent', 'billing']);
  });

  it('leaves plain strings alone', () => {
    const row = { name: 'Acme', description: 'Just a company' };
    const out = reviveStringifiedJson(row);
    assert.equal(out.name, 'Acme');
    assert.equal(out.description, 'Just a company');
  });

  it('leaves non-JSON strings alone even if they start with curly/bracket', () => {
    // Markdown content, log lines, etc. Don't corrupt user data.
    const row = { note: '{ this is not json' };
    const out = reviveStringifiedJson(row);
    assert.equal(out.note, '{ this is not json');
  });

  it('leaves non-string values untouched', () => {
    const row = { id: 42, active: true, tags: null };
    const out = reviveStringifiedJson(row);
    assert.equal(out.id, 42);
    assert.equal(out.active, true);
    assert.equal(out.tags, null);
  });

  it('does not mutate the input', () => {
    const row = { id: '{"x":1}' };
    const original = row.id;
    reviveStringifiedJson(row);
    assert.equal(row.id, original, 'input must not be mutated');
  });
});
