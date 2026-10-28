import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  actionName,
  actionNames,
  buildHandoff,
  encodeHandoff,
  clientFields,
  connectorRule,
  findConfigFile,
  loadConfigFile,
  readEnvValue,
  renderTypes,
  resolveActions,
  upsertEnv,
  validateConfig,
} from './connect-app.js';

describe('actionName', () => {
  it('camel-cases a title', () => {
    assert.equal(actionName('Send Email'), 'sendEmail');
    assert.equal(actionName('List and View Email Threads'), 'listAndViewEmailThreads');
    assert.equal(actionName('GET a contact (v2)'), 'getAContactV2');
  });
});

describe('actionNames', () => {
  it('leaves out a name two actions share, so a name never picks one silently', () => {
    const names = actionNames([
      { systemId: 'conn_mod_def::a', title: 'Send Email' },
      { systemId: 'conn_mod_def::b', title: 'List Labels' },
      { systemId: 'conn_mod_def::c', title: 'list labels' },
    ]);
    assert.deepEqual([...names.entries()], [['sendEmail', 'conn_mod_def::a']]);
  });
});

describe('resolveActions', () => {
  const names = new Map([['sendEmail', 'conn_mod_def::a']]);
  const ids = new Set(['conn_mod_def::a', 'conn_mod_def::b']);

  it('turns names and known ids into ids, once each', () => {
    assert.deepEqual(resolveActions(['sendEmail', 'conn_mod_def::b', 'conn_mod_def::a'], names, ids), {
      ids: ['conn_mod_def::a', 'conn_mod_def::b'],
    });
  });

  it('names everything that did not match', () => {
    assert.deepEqual(resolveActions(['sendEmails', 'conn_mod_def::zzz'], names, ids), {
      unknown: ['sendEmails', 'conn_mod_def::zzz'],
    });
  });
});

describe('connectorRule', () => {
  it('maps each level to the methods the dashboard writes', () => {
    assert.deepEqual(connectorRule(7, { access: 'read-only' }).methods, ['GET']);
    assert.deepEqual(connectorRule(7, { access: 'read-write' }).methods, ['GET', 'POST', 'PUT', 'PATCH']);
    assert.deepEqual(connectorRule(7, { access: 'full-access' }), {
      type: 'connectionDefinition',
      connectionDefinitionId: 7,
      methods: null,
      actionIds: null,
    });
  });

  it('narrows a custom ask to its actions', () => {
    assert.deepEqual(connectorRule(7, { access: 'custom', actions: ['sendEmail'] }, ['conn_mod_def::a']), {
      type: 'connectionDefinition',
      connectionDefinitionId: 7,
      methods: null,
      actionIds: ['conn_mod_def::a'],
    });
  });
});

describe('clientFields', () => {
  it('sends only what the file sets, branding as the frontend spec', () => {
    assert.deepEqual(
      clientFields({
        name: ' Mastra ',
        redirectUris: ['http://localhost:3000/api/one/callback'],
        reason: 'Mastra plans your day',
        branding: { panelColor: '#A02235', buttonColor: '#6A2557' },
      }),
      {
        name: 'Mastra',
        redirectUris: ['http://localhost:3000/api/one/callback'],
        consentReason: 'Mastra plans your day',
        frontend: { panelColor: '#A02235', buttonColor: '#6A2557', cobrandEmail: false },
      }
    );
  });
});

describe('validateConfig', () => {
  it('accepts a complete config', () => {
    const result = validateConfig({
      name: 'Mastra',
      redirectUris: ['https://app.mastra.ai/api/one/callback'],
      ask: { gmail: { access: 'custom', actions: ['sendEmail'] }, linear: { access: 'read-write' } },
    });
    assert.ok('config' in result);
  });

  it('lists every problem at once', () => {
    const result = validateConfig({
      name: '',
      redirectUris: ['localhost:3000/callback'],
      branding: { panelColor: 'red', buttonColor: '#6A2557' },
      ask: { gmail: { access: 'custom', actions: [] }, linear: { access: 'write' } },
    });
    assert.ok('errors' in result);
    assert.equal(result.errors.length, 5);
  });
});

describe('upsertEnv', () => {
  it('replaces in place, keeps other lines, and appends what is missing', () => {
    const before = '# app\nDATABASE_URL=postgres://x\nONE_CLIENT_ID=old\n';
    assert.equal(
      upsertEnv(before, { ONE_CLIENT_ID: 'new', ONE_REDIRECT_URI: 'http://localhost:3000/api/one/callback' }),
      '# app\nDATABASE_URL=postgres://x\nONE_CLIENT_ID=new\nONE_REDIRECT_URI=http://localhost:3000/api/one/callback\n'
    );
  });

  it('never clears a secret already pasted in', () => {
    const before = 'ONE_CLIENT_SECRET=one_secret_kept';
    assert.equal(
      upsertEnv(before, { ONE_CLIENT_SECRET: null, ONE_CONNECT_KEY: null }),
      'ONE_CLIENT_SECRET=one_secret_kept\nONE_CONNECT_KEY=\n'
    );
    assert.equal(readEnvValue('ONE_CLIENT_ID="abc"\n', 'ONE_CLIENT_ID'), 'abc');
  });
});

describe('config files', () => {
  it('finds and loads an .mjs config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-connect-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'one.connect.mjs'),
        'export default { name: "Mastra", redirectUris: ["http://localhost:3000/api/one/callback"] };\n'
      );
      const file = findConfigFile(dir);
      assert.equal(file, path.join(dir, 'one.connect.mjs'));
      assert.deepEqual(await loadConfigFile(file!), {
        name: 'Mastra',
        redirectUris: ['http://localhost:3000/api/one/callback'],
      });
      assert.equal(findConfigFile(dir, 'missing.ts'), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says to install the SDK when the project has none, or one without /config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-connect-'));
    try {
      const file = path.join(dir, 'one.connect.mjs');
      fs.writeFileSync(
        file,
        'import { defineConnectApp } from "@withone/connect/config";\nexport default defineConnectApp({ name: "Mastra" });\n'
      );
      await assert.rejects(loadConfigFile(file), /isn't installed in this project\. Run `npm i @withone\/connect` first/);

      const sdk = path.join(dir, 'node_modules', '@withone', 'connect');
      fs.mkdirSync(sdk, { recursive: true });
      fs.writeFileSync(
        path.join(sdk, 'package.json'),
        JSON.stringify({ name: '@withone/connect', version: '0.18.0', exports: { '.': './index.js' } })
      );
      await assert.rejects(loadConfigFile(file), /older than 0\.19\.0.*npm i @withone\/connect@latest/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderTypes', () => {
  it('augments the registry with every tool and the asked tools’ action names', () => {
    const text = renderTypes(['linear', 'gmail'], { gmail: ['sendEmail', 'createDraft'] });
    assert.match(text, /declare module "@withone\/connect\/config"/);
    assert.match(text, /tools: "gmail" \| "linear";/);
    assert.match(text, /"gmail": "createDraft" \| "sendEmail";/);
  });
});

describe('handoff', () => {
  const config = {
    name: ' Mastra ',
    redirectUris: ['http://localhost:3000/api/one/callback'],
    reason: 'Plans your day',
  };

  it('carries the app fields and the resolved ask, or null for no ask', () => {
    const rule = connectorRule(7, { access: 'read-only' });
    assert.deepEqual(buildHandoff(config, [rule]), {
      v: 1,
      app: { name: 'Mastra', redirectUris: config.redirectUris, consentReason: 'Plans your day' },
      ask: [rule],
    });
    assert.equal(buildHandoff(config, []).ask, null);
  });

  it('encodes as deflated base64url JSON that inflates back', () => {
    const handoff = buildHandoff(config, []);
    const encoded = encodeHandoff(handoff);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    const json = zlib.inflateRawSync(Buffer.from(encoded, 'base64url')).toString('utf8');
    assert.deepEqual(JSON.parse(json), handoff);
  });

  it('roughly halves a long list of action ids', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `conn_mod_def::GJ7Km${i}Q::C4xVtTCm${i}TjeKrcf-4UV9Iw`);
    const handoff = buildHandoff(config, [connectorRule(7, { access: 'custom', actions: ids }, ids)]);
    const plain = Buffer.from(JSON.stringify(handoff)).toString('base64url').length;
    assert.ok(encodeHandoff(handoff).length < plain / 2);
  });
});
