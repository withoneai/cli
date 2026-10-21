import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

import {
  applyCaGuard,
  caGuardWarning,
  filterDistrustedRoots,
  isDistrustedRoot,
  nodeHasEmudhraFix,
} from './ca-guard.js';

const cn = (pem: string) =>
  new X509Certificate(pem).subject.split('\n').find((l) => l.startsWith('CN='))?.slice(3);

const bundled = [...tls.rootCertificates];
const emsignEccG3 = bundled.find((pem) => cn(pem) === 'emSign ECC Root CA - G3');

describe('nodeHasEmudhraFix', () => {
  it('knows the first fixed patch of each supported line', () => {
    assert.equal(nodeHasEmudhraFix('22.23.4'), true);
    assert.equal(nodeHasEmudhraFix('22.23.3'), false);
    assert.equal(nodeHasEmudhraFix('22.24.0'), true);
    assert.equal(nodeHasEmudhraFix('24.22.1'), true);
    assert.equal(nodeHasEmudhraFix('24.22.0'), false);
    assert.equal(nodeHasEmudhraFix('24.14.0'), false);
    assert.equal(nodeHasEmudhraFix('26.12.1'), true);
    assert.equal(nodeHasEmudhraFix('26.12.0'), false);
  });

  it('treats end-of-life lines as unfixed and later lines as fixed', () => {
    for (const v of ['18.20.8', '20.19.5', '23.11.1', '25.9.0']) {
      assert.equal(nodeHasEmudhraFix(v), false, v);
    }
    assert.equal(nodeHasEmudhraFix('27.0.0'), true);
    assert.equal(nodeHasEmudhraFix('garbage'), false);
  });
});

describe('filterDistrustedRoots', () => {
  it('removes only emSign ECC Root CA - G3 from the bundled Mozilla roots', (t) => {
    if (!emsignEccG3) return t.skip('this Node no longer bundles the root');
    const { kept, removed } = filterDistrustedRoots(bundled);
    assert.deepEqual(removed, ['emSign ECC Root CA - G3']);
    assert.equal(kept.length, bundled.length - 1);
    assert.ok(!kept.includes(emsignEccG3));
  });

  it('keeps the other emSign roots, which did not sign the intermediates', () => {
    for (const name of ['emSign Root CA - G1', 'emSign Root CA - C1', 'emSign ECC Root CA - C3']) {
      const pem = bundled.find((p) => cn(p) === name);
      if (pem) assert.equal(isDistrustedRoot(pem), false, name);
    }
  });

  it('keeps the roots our own domains chain to', () => {
    for (const name of ['ISRG Root X1', 'GTS Root R4']) {
      const pem = bundled.find((p) => cn(p) === name);
      assert.ok(pem, `${name} is bundled`);
      assert.equal(isDistrustedRoot(pem), false, name);
    }
  });

  it('ignores input that is not a certificate', () => {
    assert.equal(isDistrustedRoot('not a pem'), false);
  });
});

describe('applyCaGuard', () => {
  it('sets the default CA list without the distrusted root', (t) => {
    if (!emsignEccG3) return t.skip('this Node no longer bundles the root');
    let set: string[] | null = null;
    const fake = {
      getCACertificates: () => bundled,
      setDefaultCACertificates: (certs: string[]) => {
        set = certs;
      },
    } as unknown as Parameters<typeof applyCaGuard>[0];
    const result = applyCaGuard(fake);
    assert.deepEqual(result, { status: 'applied', removed: ['emSign ECC Root CA - G3'] });
    assert.ok(set);
    assert.equal((set as string[]).length, bundled.length - 1);
  });

  it('does nothing when the list is already clean', () => {
    let called = false;
    const fake = {
      getCACertificates: () => bundled.filter((p) => p !== emsignEccG3),
      setDefaultCACertificates: () => {
        called = true;
      },
    } as unknown as Parameters<typeof applyCaGuard>[0];
    assert.deepEqual(applyCaGuard(fake), { status: 'clean' });
    assert.equal(called, false);
  });

  it('reports unsupported on a Node without the CA list API', () => {
    assert.deepEqual(applyCaGuard({} as Parameters<typeof applyCaGuard>[0]), { status: 'unsupported' });
  });

  it('never throws', () => {
    const fake = {
      getCACertificates: () => {
        throw new Error('boom');
      },
      setDefaultCACertificates: () => {},
    } as unknown as Parameters<typeof applyCaGuard>[0];
    assert.deepEqual(applyCaGuard(fake), { status: 'error', message: 'boom' });
  });

  it('removes the root from the real process defaults', (t) => {
    if (!emsignEccG3 || typeof tls.getCACertificates !== 'function') return t.skip('not applicable');
    applyCaGuard();
    assert.ok(!tls.getCACertificates('default').includes(emsignEccG3));
  });
});

describe('caGuardWarning', () => {
  it('is silent when the guard ran or found nothing', () => {
    assert.equal(caGuardWarning({ status: 'applied', removed: ['x'] }, '20.0.0'), null);
    assert.equal(caGuardWarning({ status: 'clean' }, '20.0.0'), null);
  });

  it('is silent on a Node that has the fix itself', () => {
    assert.equal(caGuardWarning({ status: 'unsupported' }, '24.22.1'), null);
  });

  it('tells users on an old Node to update', () => {
    const warning = caGuardWarning({ status: 'unsupported' }, '20.19.5');
    assert.match(warning ?? '', /Node\.js v20\.19\.5/);
    assert.match(warning ?? '', /22\.23\.4, 24\.22\.1 or 26\.12\.1/);
  });
});
