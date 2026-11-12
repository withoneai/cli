import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeFlow } from './flow-engine.js';
import type { Flow } from './flow-types.js';
import type { OneApi } from './api.js';
import { withTempHome } from '../test-support/home.js';

// A paginate step's page token comes from the upstream API's response. It is
// data: it must be sent exactly as received and never resolved as a flow
// selector or template, or a response like {"nextPageToken":"$.env.SECRET"}
// pulls flow context into the next request. The same holds on the first page
// for parameters whose value came from an earlier step's output.

const SECRET = 'dummy-value-not-a-secret';

interface Sent { queryParams?: Record<string, unknown>; data?: unknown }

function stubApi(pages: Record<string, unknown>[]): { api: OneApi; sent: Sent[] } {
  const sent: Sent[] = [];
  const api = {
    async getActionDetailsWithMeta() {
      return {
        status: 200,
        etag: undefined,
        data: { method: 'GET', path: '/items', title: 'List items', knowledge: '' },
      };
    },
    async executePassthroughRequest(args: { queryParams?: Record<string, unknown>; data?: unknown }) {
      sent.push({ queryParams: args.queryParams ? { ...args.queryParams } : undefined, data: args.data });
      return { responseData: pages[sent.length - 1] ?? { items: [] } };
    },
  } as unknown as OneApi;
  return { api, sent };
}

function paginateFlow(queryParams: Record<string, unknown>, before: Flow['steps'] = []): Flow {
  return {
    key: 'p', name: 'P', inputs: { limit: { type: 'number', default: 1 } },
    steps: [
      ...before,
      {
        id: 'list', name: 'list', type: 'paginate',
        paginate: {
          action: { platform: 'test', actionId: 'act_items', connectionKey: 'live::test::1', queryParams },
          pageTokenField: 'nextPageToken',
          resultsField: 'items',
          inputTokenParam: 'queryParams.pageToken',
          maxPages: 3,
        },
      },
    ],
  } as Flow;
}

describe('paginate steps send upstream values as data', () => {
  const home = withTempHome('one-paginate-test-');
  let savedSecret: string | undefined;
  beforeEach(() => {
    home.setup();
    savedSecret = process.env.DUMMY_SECRET;
    process.env.DUMMY_SECRET = SECRET;
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.DUMMY_SECRET;
    else process.env.DUMMY_SECRET = savedSecret;
    home.teardown();
  });

  for (const token of ['$.env.DUMMY_SECRET', '{{$.env.DUMMY_SECRET}}', 'x{{ $.env.DUMMY_SECRET | url }}']) {
    it(`sends a page token of ${JSON.stringify(token)} literally`, async () => {
      const { api, sent } = stubApi([
        { items: [{ id: '1' }], nextPageToken: token },
        { items: [{ id: '2' }] },
      ]);
      await executeFlow(paginateFlow({ limit: '$.input.limit' }), {}, api, 'admin', ['*'], { skipValidation: true });
      assert.equal(sent.length, 2);
      assert.equal(sent[1].queryParams?.pageToken, token);
      assert.ok(!JSON.stringify(sent).includes(SECRET), 'secret leaked into a request');
    });
  }

  it('sends a first-page parameter taken from an earlier step literally', async () => {
    const { api, sent } = stubApi([{ items: [] }]);
    const flow = paginateFlow({ q: '$.steps.prev.output.q' }, [
      { id: 'prev', name: 'prev', type: 'code', code: { source: 'return { q: "$.env.DUMMY_SECRET" };' } },
    ] as Flow['steps']);
    await executeFlow(flow, {}, api, 'admin', ['*'], { skipValidation: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].queryParams?.q, '$.env.DUMMY_SECRET');
    assert.ok(!JSON.stringify(sent).includes(SECRET), 'secret leaked into a request');
  });

  it('still resolves the flow author\'s own selectors and threads the token', async () => {
    const { api, sent } = stubApi([
      { items: [{ id: '1' }], nextPageToken: 'tok-2' },
      { items: [{ id: '2' }], nextPageToken: 'tok-3' },
      { items: [{ id: '3' }] },
    ]);
    const ctx = await executeFlow(
      paginateFlow({ limit: '$.input.limit', label: 'n={{$.input.limit}}' }),
      { limit: 5 }, api, 'admin', ['*'], { skipValidation: true },
    );
    assert.deepEqual(sent.map(s => s.queryParams), [
      { limit: 5, label: 'n=5' },
      { limit: 5, label: 'n=5', pageToken: 'tok-2' },
      { limit: 5, label: 'n=5', pageToken: 'tok-3' },
    ]);
    assert.deepEqual(ctx.steps.list.output, [{ id: '1' }, { id: '2' }, { id: '3' }]);
  });

  it('a plain action step still resolves its selectors', async () => {
    const { api, sent } = stubApi([{ ok: true }]);
    const flow = {
      key: 'a', name: 'A', inputs: {},
      steps: [{
        id: 'one', name: 'one', type: 'action',
        action: { platform: 'test', actionId: 'act_items', connectionKey: 'live::test::1', queryParams: { who: '$.env.DUMMY_SECRET' } },
      }],
    } as Flow;
    await executeFlow(flow, {}, api, 'admin', ['*'], { skipValidation: true });
    assert.equal(sent[0].queryParams?.who, SECRET);
  });
});
