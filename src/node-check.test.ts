import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nodeHasTlsFix, unpatchedNodeMessage, upgradeCommand } from './node-check.js';

describe('nodeHasTlsFix', () => {
  it('knows the first fixed patch of each supported line', () => {
    assert.equal(nodeHasTlsFix('22.23.4'), true);
    assert.equal(nodeHasTlsFix('22.23.3'), false);
    assert.equal(nodeHasTlsFix('22.24.0'), true);
    assert.equal(nodeHasTlsFix('24.22.1'), true);
    assert.equal(nodeHasTlsFix('24.22.0'), false);
    assert.equal(nodeHasTlsFix('24.14.0'), false);
    assert.equal(nodeHasTlsFix('26.12.1'), true);
    assert.equal(nodeHasTlsFix('26.12.0'), false);
  });

  it('treats end-of-life lines as unfixed and later lines as fixed', () => {
    for (const v of ['18.20.8', '20.19.5', '23.11.1', '25.9.0']) {
      assert.equal(nodeHasTlsFix(v), false, v);
    }
    assert.equal(nodeHasTlsFix('27.0.0'), true);
    assert.equal(nodeHasTlsFix('garbage'), false);
  });
});

describe('upgradeCommand', () => {
  it('keeps a fixed line and moves an end-of-life one to 24', () => {
    assert.equal(
      upgradeCommand('22.10.0', '/Users/me/.nvm/versions/node/v22.10.0/bin/node'),
      'nvm install 22 && nvm alias default 22',
    );
    assert.equal(
      upgradeCommand('20.19.5', '/Users/me/.nvm/versions/node/v20.19.5/bin/node'),
      'nvm install 24 && nvm alias default 24',
    );
  });

  it('matches each version manager by the binary path', () => {
    assert.equal(
      upgradeCommand('20.19.5', 'C:\\Users\\me\\AppData\\Roaming\\nvm\\v20.19.5\\node.exe'),
      'nvm install 24 && nvm use 24',
    );
    assert.equal(
      upgradeCommand('20.19.5', '/Users/me/.volta/tools/image/node/20.19.5/bin/node'),
      'volta install node@24',
    );
    assert.equal(
      upgradeCommand('20.19.5', '/Users/me/.local/share/fnm/node-versions/v20.19.5/installation/bin/node'),
      'fnm install 24 && fnm default 24',
    );
  });

  it('upgrades a fixed Homebrew formula in place and replaces an end-of-life one', () => {
    assert.equal(upgradeCommand('26.1.0', '/opt/homebrew/Cellar/node/26.1.0/bin/node'), 'brew upgrade node');
    assert.equal(upgradeCommand('22.10.0', '/opt/homebrew/Cellar/node@22/22.10.0/bin/node'), 'brew upgrade node@22');
    assert.equal(upgradeCommand('20.19.5', '/opt/homebrew/Cellar/node@20/20.19.5/bin/node'), 'brew install node@24');
  });

  it('falls back to nodejs.org', () => {
    assert.equal(upgradeCommand('20.19.5', '/usr/local/bin/node'), 'download Node.js 24 from https://nodejs.org');
  });
});

describe('unpatchedNodeMessage', () => {
  it('names the running version and the versions to update to', () => {
    const message = unpatchedNodeMessage('20.19.5');
    assert.match(message, /Node\.js v20\.19\.5/);
    assert.match(message, /22\.23\.4\+, 24\.22\.1\+ or 26\.12\.1\+/);
  });
});
