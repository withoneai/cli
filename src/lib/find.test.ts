import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTE_GUIDE,
  FindArgsError,
  REFUSED_LOAD,
  find,
  load,
  renderFind,
  type DocumentedAction,
  type FindDeps,
  type FindSettings,
} from './find.js';
import type { ActionDetails, FindIntent, FoundAction, FoundActions } from './types.js';

// Pure: core and the knowledge endpoint are stubbed, so nothing touches the
// network or the home directory.

const LARGE = [
  '# Send Email',
  '## Endpoint\nPOST /v1/gmail/send-email',
  '## Request Body\n### Required Request Body Fields\n- to: string',
  `## Response Fields\n${Array.from({ length: 400 }, (_, i) => `- field ${i}: a described response field`).join('\n')}`,
].join('\n\n');

const action = (id: string, method = 'POST', tags: string[] = []): FoundAction => ({
  systemId: id,
  title: `Action ${id}`,
  key: `key-${id}`,
  method,
  path: `/v1/${id}`,
  tags,
});

const answer = (overrides: Partial<FoundActions> = {}): FoundActions => ({
  platform: 'gmail',
  intent: 'send an email',
  selected: [action('a')],
  alternatives: [action('b'), action('c', 'GET')],
  selector: 'model',
  confidence: 0.92,
  ...overrides,
});

const settings = (overrides: Partial<FindSettings> = {}): FindSettings => ({
  knowledgeAgent: false,
  permissions: 'admin',
  actionIds: ['*'],
  connectionKeys: ['*'],
  apiBase: 'https://api.withone.ai/v1',
  ...overrides,
});

function deps(
  answers: FoundActions[],
  knowledge: Record<string, string> = {},
  platforms: string[] = ['gmail']
): FindDeps & { asked: FindIntent[][] } {
  const asked: FindIntent[][] = [];
  return {
    asked,
    async findActions(requests) {
      asked.push(requests);
      return answers.slice(0, requests.length);
    },
    async getActionDetails(id): Promise<ActionDetails> {
      if (id === 'missing') throw new Error('not found');
      return {
        _id: id,
        title: `Action ${id}`,
        method: id === 'c' ? 'GET' : 'POST',
        path: `/v1/${id}`,
        tags: id === 'custom' ? ['custom'] : [],
        knowledge: knowledge[id] ?? `# Action ${id}\n\nSmall doc for ${id}.`,
        connectionPlatform: 'gmail',
      };
    },
    async connectedPlatforms() {
      return platforms;
    },
  };
}

const intent = [{ platform: 'gmail', intent: 'send an email' }];

describe('actions find', () => {
  it('refuses more than ten intents and a blank one', async () => {
    await assert.rejects(find(Array(11).fill(intent[0]), undefined, deps([]), settings()), FindArgsError);
    await assert.rejects(find([{ platform: 'gmail', intent: ' ' }], undefined, deps([]), settings()), FindArgsError);
  });

  it('searches the catalog for code and flows when asked, or always in knowledge-only mode', async () => {
    const seen: boolean[] = [];
    const spy = (base: FindDeps): FindDeps => ({
      ...base,
      findActions: (requests, task, knowledgeAgent) => {
        seen.push(knowledgeAgent);
        return base.findActions(requests, task, knowledgeAgent);
      },
    });

    await find(intent, undefined, spy(deps([answer()])), settings());
    await find(intent, undefined, spy(deps([answer()])), settings(), { knowledgeCatalog: true });
    await find(intent, undefined, spy(deps([answer()])), settings({ knowledgeAgent: true }));
    assert.deepEqual(seen, [false, true, true]);
  });

  it('documents the pick from its raw knowledge as a digest naming the exact load command', async () => {
    const result = await find(intent, 'email a report to a contact', deps([answer()], { a: LARGE }), settings());
    const [first] = result.answers;

    const pick = first.selected[0] as DocumentedAction;

    assert.equal(first.status, 'Chosen with confidence 0.92.');
    assert.equal(pick.actionId, 'a');
    assert.equal(pick.truncated, true);
    assert.ok(pick.knowledge.includes('one --agent actions load a --section "'));
    assert.ok(!pick.knowledge.includes('actions knowledge'));
    assert.deepEqual(first.alternatives.map((a) => a.actionId), ['b', 'c']);
    assert.equal(result.guide, EXECUTE_GUIDE, 'the execute guide is stated once, not per action');
  });

  it('lists every chosen action without fetching documentation when knowledge is off', async () => {
    const fetched: string[] = [];
    const base = deps([answer({ selected: [action('a'), action('c', 'GET')], runnerUp: action('b') , alternatives: [action('d')] })]);
    const counting: FindDeps = {
      ...base,
      getActionDetails: (id) => {
        fetched.push(id);
        return base.getActionDetails(id);
      },
    };
    const result = await find(intent, undefined, counting, settings({ knowledgeAgent: true }), { knowledge: false });
    const [first] = result.answers;

    assert.deepEqual(fetched, [], 'no documentation is fetched');
    assert.deepEqual(first.selected, [
      { actionId: 'a', title: 'Action a', method: 'POST', path: '/v1/a' },
      { actionId: 'c', title: 'Action c', method: 'GET', path: '/v1/c' },
    ], 'every pick is listed, even in knowledge-only mode');
    assert.deepEqual(first.runnerUp, { actionId: 'b', title: 'Action b', method: 'POST', path: '/v1/b' });
    assert.equal(result.guide, undefined, 'nothing was documented, so no closing guide');
    const text = renderFind(result);
    assert.ok(text.includes('Chosen for this intent (load with `one actions load <actionId>`):\n- Action a'));
    assert.ok(!text.includes('documentation left out'));
  });

  it('sets the runner-up apart as a substitute, documented', async () => {
    const result = await find(intent, undefined, deps([answer({ runnerUp: action('b'), alternatives: [] })]), settings());
    const text = renderFind(result);

    assert.ok(text.includes('use this one instead: one or the other, never both.\n\n### Action b'));
  });

  it('replaces a refused pick even when a companion survives, and never offers a refused action', async () => {
    const result = await find(
      intent,
      undefined,
      deps([answer({ selected: [action('a'), action('c', 'GET')], runnerUp: action('d', 'GET'), alternatives: [action('b')] })]),
      settings({ permissions: 'read' })
    );
    const [first] = result.answers;

    assert.match(first.status, /^The chosen action is not allowed by this CLI/);
    assert.deepEqual(first.selected.map((a) => a.actionId), ['d', 'c'], 'the runner-up stands in first, the companion after it');
    assert.equal(first.runnerUp, undefined);
    assert.deepEqual(first.alternatives, [], 'the POST alternative is refused under read');
  });

  it('says the settings are why when they refuse every action found', async () => {
    const result = await find(intent, undefined, deps([answer({ alternatives: [action('b')] })]), settings({ permissions: 'read' }));

    assert.match(result.answers[0].status, /allow none of them, so rephrasing will not help/);
    assert.equal(result.guide, undefined, 'nothing was documented, so no closing guide');
  });

  it('answers an unreachable platform without asking core about it', async () => {
    const core = deps([answer({ platform: 'slack', intent: 'post a message' })], {}, ['slack']);
    const result = await find(
      [intent[0], { platform: 'slack', intent: 'post a message' }],
      undefined,
      core,
      settings({ connectionKeys: ['live::slack::default::k'] })
    );

    assert.deepEqual(core.asked, [[{ platform: 'slack', intent: 'post a message' }]]);
    assert.match(result.answers[0].status, /^Platform "gmail" has no allowed connections/);
    assert.equal(result.answers[1].platform, 'slack');
  });

  it('in knowledge mode documents the pick whole with how to call it from code, lists the rest, and states the rules once', async () => {
    const result = await find(
      intent,
      undefined,
      deps([answer({ selected: [action('custom', 'POST', ['custom']), action('b')] })], { custom: LARGE }),
      settings({ knowledgeAgent: true })
    );
    const pick = result.answers[0].selected[0] as DocumentedAction;

    assert.ok(pick.knowledge.includes(LARGE), 'the whole document, not a digest');
    assert.ok(pick.knowledge.includes('URL:    https://api.withone.ai/v1/passthrough/v1/custom'));
    assert.ok(pick.knowledge.includes('This is a custom action'));
    assert.deepEqual(result.answers[0].alsoSelected.map((a) => a.actionId), ['b']);
    assert.match(result.guide ?? '', /INTEGRATION CODE GUIDE/);
  });
});

describe('actions find, when things go wrong', () => {
  it('fails clearly when core answers fewer intents than it was asked', async () => {
    await assert.rejects(find(intent, undefined, deps([]), settings()), /One answered 0 of 1 requests/);
  });

  it('never presents a failed documentation fetch as an action with no documentation', async () => {
    const failing: FindDeps = {
      ...deps([answer()]),
      getActionDetails: async () => {
        throw new Error('503 Service Unavailable');
      },
    };
    const result = await find(intent, undefined, failing, settings());
    const pick = result.answers[0].selected[0] as DocumentedAction;

    assert.match(pick.knowledge, /could not be loaded \(503 Service Unavailable\)/);
    assert.match(pick.knowledge, /one --agent actions load a/);
    assert.equal(pick.truncated, true);
  });

  it('never presents a companion as the pick when nothing can replace a refused pick', async () => {
    const result = await find(
      intent,
      undefined,
      deps([answer({ selected: [action('a'), action('c', 'GET')], alternatives: [] })]),
      settings({ permissions: 'read' })
    );
    const [first] = result.answers;

    assert.deepEqual(first.selected, []);
    assert.deepEqual(first.alsoSelected.map((a) => a.actionId), ['c']);
    assert.match(first.status, /no allowed candidate can take its place/);
  });

  it('matches a platform against the allowed connections whatever its case', async () => {
    const result = await find(
      [{ platform: 'Gmail', intent: 'send an email' }],
      undefined,
      deps([answer()], {}, ['gmail']),
      settings({ connectionKeys: ['k'] })
    );

    assert.equal(result.answers[0].selected[0].actionId, 'a');
  });
});

describe('actions load', () => {
  it('serves the part each flag asks for, and refuses an action the CLI may not use as it would a missing one', async () => {
    const sections = await load(['a', 'missing', 'b'], { section: 'Response Fields' }, deps([], { a: LARGE }), settings({ actionIds: ['a', 'missing'] }));

    const a = sections.loaded[0] as DocumentedAction;
    assert.ok(a.knowledge.includes('field 399'));
    assert.ok(!a.knowledge.includes('POST /v1/gmail/send-email'), 'only the named section');
    assert.deepEqual(sections.loaded[1], { actionId: 'missing', error: REFUSED_LOAD });
    assert.deepEqual(sections.loaded[2], { actionId: 'b', error: REFUSED_LOAD });

    const toc = await load(['a'], { toc: true }, deps([], { a: LARGE }), settings());
    assert.match((toc.loaded[0] as DocumentedAction).knowledge, /^Table of contents\. Load any with: one --agent actions load a --section/);

    const full = await load(['a'], { full: true }, deps([], { a: LARGE }), settings());
    assert.equal((full.loaded[0] as DocumentedAction).knowledge, LARGE);
  });

  it('serves an action that names no platform under scoped keys, with a placeholder env var in knowledge mode', async () => {
    const unplaced: FindDeps = {
      ...deps([]),
      getActionDetails: async (id: string): Promise<ActionDetails> => ({ _id: id, title: 'X', method: 'GET', path: '/x', knowledge: '# X' }),
    };
    const result = await load(['x'], {}, unplaced, settings({ connectionKeys: ['k'], knowledgeAgent: true }));

    assert.match((result.loaded[0] as DocumentedAction).knowledge, /ONE_PLATFORM_CONNECTION_KEY/);
  });

  it('serves the first document it actually returns, however large, even after a refused entry', async () => {
    const huge = `# Huge\n\n${'x'.repeat(450_000)}`;
    const result = await load(['missing', 'a'], { full: true }, deps([], { a: huge }), settings());

    assert.equal((result.loaded[1] as DocumentedAction).knowledge, huge);
  });
});
