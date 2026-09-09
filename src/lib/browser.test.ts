import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApiKeyUrl, getCliAuthUrl, getConnectionUrl, oneAppUrl } from './browser.js';

describe('oneAppUrl', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.ONE_APP_URL; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ONE_APP_URL;
    else process.env.ONE_APP_URL = saved;
  });

  it('defaults to the hosted dashboard', () => {
    delete process.env.ONE_APP_URL;
    assert.equal(oneAppUrl(), 'https://app.withone.ai');
  });

  it('honours ONE_APP_URL lazily and strips a trailing slash', () => {
    process.env.ONE_APP_URL = 'http://localhost:4202/';
    assert.equal(oneAppUrl(), 'http://localhost:4202');
    assert.equal(getApiKeyUrl(), 'http://localhost:4202/settings/api-keys');
    assert.equal(getConnectionUrl('gmail'), 'http://localhost:4202/#open=gmail');
  });
});

describe('getCliAuthUrl', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.ONE_APP_URL; delete process.env.ONE_APP_URL; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ONE_APP_URL;
    else process.env.ONE_APP_URL = saved;
  });

  it('keeps the legacy shape when no context is given', () => {
    const url = new URL(getCliAuthUrl(51234, 'a b'));
    assert.equal(url.origin + url.pathname, 'https://app.withone.ai/cli/auth');
    assert.deepEqual([...url.searchParams.keys()], ['port', 'state']);
    assert.equal(url.searchParams.get('port'), '51234');
    assert.equal(url.searchParams.get('state'), 'a b');
  });

  it('appends the install context after port and state', () => {
    const url = new URL(getCliAuthUrl(51234, 'st', {
      scope: 'project',
      path: '/Users/paul/dev/acme app',
      host: 'box',
      os: 'darwin',
      arch: 'arm64',
      harnesses: ['claude-code'],
    }));
    assert.equal(url.pathname, '/cli/auth');
    assert.deepEqual([...url.searchParams.keys()].slice(0, 2), ['port', 'state']);
    assert.equal(url.searchParams.get('port'), '51234');
    assert.equal(url.searchParams.get('state'), 'st');
    assert.equal(url.searchParams.get('scope'), 'project');
    assert.equal(url.searchParams.get('path'), '/Users/paul/dev/acme app');
    assert.equal(url.searchParams.get('harnesses'), 'claude-code');
    assert.equal(url.searchParams.get('user'), null);
  });
});
