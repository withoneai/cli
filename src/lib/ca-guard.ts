import tls from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';

/**
 * eMudhra CA compromise, October 2026 (RUSTSEC-2026-0381, Node.js
 * 2026-10-21 security release).
 *
 * Eight eMudhra/emSign intermediate CAs were created with 8-bit private keys,
 * so anyone can compute them and sign a certificate for any domain. Browsers
 * blocked them on Oct 17. Node.js only blocks them from 22.23.4, 24.22.1 and
 * 26.12.1; every older Node a user runs us on still accepts a forged
 * certificate for api.withone.ai, which would hand an attacker on the network
 * the user's API key.
 *
 * Node's own fix blocks the eight intermediates by key inside the TLS
 * handshake, which userland cannot do. What userland can do is what Mozilla
 * NSS, webpki-roots and Ubuntu did: stop trusting the roots those
 * intermediates chain to. That closes every path to them.
 */

/** SPKI SHA-256 of emSign ECC Root CA - G3, the root that signed the intermediates (as removed in webpki-roots 1.0.10). */
const DISTRUSTED_ROOT_SPKI: ReadonlySet<string> = new Set([
  '8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782',
]);

/**
 * Roots that cross-signed the intermediates (Ubuntu removed both). Neither is
 * in Node's bundled store; they can arrive through the system store
 * (`--use-system-ca`) or NODE_EXTRA_CA_CERTS, so they are matched by name.
 */
const DISTRUSTED_ROOT_NAMES: ReadonlySet<string> = new Set([
  'emSign ECC Root CA - G3',
  'emSign Root TLS CA - G3',
  'AAA Certificate Services',
]);

/** The first patch of each Node line that ships the blocklist. Odd lines (23, 25) are end-of-life and never got it. */
const FIXED_IN: Readonly<Record<number, readonly [number, number]>> = {
  22: [23, 4],
  24: [22, 1],
  26: [12, 1],
};

/** The first Node line released after the fix, so it has it from .0. */
const FIRST_LINE_WITH_FIX = 27;

export const NODE_FIX_VERSIONS = '22.23.4, 24.22.1 or 26.12.1';

function commonName(subject: string): string | undefined {
  return subject
    .split('\n')
    .find((line) => line.startsWith('CN='))
    ?.slice(3);
}

/** True for a root this guard stops trusting. */
export function isDistrustedRoot(pem: string): boolean {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return false;
  }
  const name = commonName(cert.subject);
  if (name && DISTRUSTED_ROOT_NAMES.has(name)) return true;
  const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
  return DISTRUSTED_ROOT_SPKI.has(createHash('sha256').update(spki).digest('hex'));
}

/** Splits a CA list into the roots kept and the common names of those removed. */
export function filterDistrustedRoots(pems: readonly string[]): { kept: string[]; removed: string[] } {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const pem of pems) {
    if (isDistrustedRoot(pem)) {
      let name = 'unknown';
      try {
        name = commonName(new X509Certificate(pem).subject) ?? name;
      } catch {
        // isDistrustedRoot already parsed it; unreachable in practice.
      }
      removed.push(name);
    } else {
      kept.push(pem);
    }
  }
  return { kept, removed };
}

/** True when this Node version blocks the eMudhra intermediates itself. */
export function nodeHasEmudhraFix(version: string = process.versions.node): boolean {
  const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  if (major >= FIRST_LINE_WITH_FIX) return true;
  const fixed = FIXED_IN[major];
  if (!fixed) return false;
  const [fixedMinor, fixedPatch] = fixed;
  return minor > fixedMinor || (minor === fixedMinor && (patch ?? 0) >= fixedPatch);
}

export type CaGuardResult =
  /** The distrusted roots were found and removed from the default CA list. */
  | { status: 'applied'; removed: string[] }
  /** The default CA list holds none of them: nothing to do. */
  | { status: 'clean' }
  /** This Node has no API to change the default CA list (before 22.19 / 24.5). */
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

type TlsWithDefaults = typeof tls & {
  getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

/**
 * Removes the distrusted roots from the CA list every TLS client in this
 * process uses (global fetch included). Must run before the first
 * connection: a socket already open keeps the list it was made with.
 * Never throws; a failure leaves Node's defaults untouched.
 */
export function applyCaGuard(tlsModule: TlsWithDefaults = tls): CaGuardResult {
  if (
    typeof tlsModule.getCACertificates !== 'function' ||
    typeof tlsModule.setDefaultCACertificates !== 'function'
  ) {
    return { status: 'unsupported' };
  }
  try {
    const { kept, removed } = filterDistrustedRoots(tlsModule.getCACertificates('default'));
    if (removed.length === 0) return { status: 'clean' };
    tlsModule.setDefaultCACertificates(kept);
    return { status: 'applied', removed };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The one-line stderr warning, or null when the user is protected: the guard
 * ran, or Node blocks the intermediates itself.
 */
export function caGuardWarning(
  result: CaGuardResult,
  version: string = process.versions.node,
): string | null {
  if (result.status === 'applied' || result.status === 'clean') return null;
  if (nodeHasEmudhraFix(version)) return null;
  return (
    `Warning: Node.js v${version} trusts the compromised eMudhra certificates, so a network attacker ` +
    `could intercept One's traffic and your API key. Update Node.js to ${NODE_FIX_VERSIONS} or newer.`
  );
}
