/**
 * Refuses to run on a Node.js that still trusts the compromised eMudhra
 * intermediate CAs (October 2026, RUSTSEC-2026-0381).
 *
 * Eight eMudhra/emSign intermediates were created with 8-bit private keys, so
 * anyone can compute them and sign a certificate for any domain, including
 * api.withone.ai. Node.js blocks them inside the TLS handshake from 22.23.4,
 * 24.22.1 and 26.12.1 (nodejs/node#66871). On any older Node, a network
 * attacker can intercept the CLI's traffic and the user's API key, and nothing
 * in userland can block the intermediates the way Node's fix does.
 *
 * Built as its own entry so bin/cli.js can run it before loading the rest of
 * the CLI, and before any connection opens.
 */

/** The first patch of each Node line that ships the blocklist. Odd lines (23, 25) are end-of-life and never got it. */
const FIXED_IN: Readonly<Record<number, readonly [number, number]>> = {
  22: [23, 4],
  24: [22, 1],
  26: [12, 1],
};

/** The first Node line released after the fix, so it has it from .0. */
const FIRST_LINE_WITH_FIX = 27;

export const NODE_FIX_VERSIONS = '22.23.4, 24.22.1 or 26.12.1';

/** True when this Node version rejects chains through the compromised eMudhra intermediates. */
export function nodeHasTlsFix(version: string = process.versions.node): boolean {
  const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  if (major >= FIRST_LINE_WITH_FIX) return true;
  const fixed = FIXED_IN[major];
  if (!fixed) return false;
  const [fixedMinor, fixedPatch] = fixed;
  return minor > fixedMinor || (minor === fixedMinor && (patch ?? 0) >= fixedPatch);
}

export function unpatchedNodeMessage(version: string = process.versions.node): string {
  return (
    `Node.js v${version} trusts the compromised eMudhra certificates, so a network attacker could ` +
    `intercept One's traffic and your API key. The One CLI will not run on it. ` +
    `Update Node.js to ${NODE_FIX_VERSIONS} or newer.`
  );
}

/**
 * Exits with an error on an unpatched Node; returns on a patched one. In agent
 * mode the error is the usual `{"error": ...}` JSON on stdout.
 */
export function requirePatchedNode(): void {
  if (nodeHasTlsFix()) return;
  const message = unpatchedNodeMessage();
  const agent = process.argv.includes('--agent') || process.env.ONE_AGENT === '1';
  if (agent) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  else process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
