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

/** The line to move to from a Node line that never got the fix. */
const RECOMMENDED_LINE = 24;

export const REQUIRED_NODE = '22.23.4+, 24.22.1+ or 26.12.1+';
export const REQUIRED_NODE_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1';

/** Set to 1 to run on an unpatched Node anyway, with a warning on every run. */
export const ALLOW_UNPATCHED_ENV = 'ONE_ALLOW_UNPATCHED_NODE';

function parseVersion(version: string): [number, number, number] {
  const [major, minor, patch] = version.split('.').map((part) => Number.parseInt(part, 10));
  return [major, minor, patch ?? 0];
}

/** True when this Node version rejects chains through the compromised eMudhra intermediates. */
export function nodeHasTlsFix(version: string = process.versions.node): boolean {
  const [major, minor, patch] = parseVersion(version);
  if (!Number.isFinite(major)) return false;
  if (major >= FIRST_LINE_WITH_FIX) return true;
  const fixed = FIXED_IN[major];
  if (!fixed) return false;
  const [fixedMinor, fixedPatch] = fixed;
  return minor > fixedMinor || (minor === fixedMinor && patch >= fixedPatch);
}

/**
 * The command that updates Node for however it was installed, judged from the
 * path of the running binary. A line that got the fix stays on its line; any
 * other moves to the recommended one.
 */
export function upgradeCommand(
  version: string = process.versions.node,
  execPath: string = process.execPath,
): string {
  const [major] = parseVersion(version);
  const line = FIXED_IN[major] ? major : RECOMMENDED_LINE;
  const path = execPath.replace(/\\/g, '/');

  if (/\/\.nvm\/versions\/node\//.test(path)) return `nvm install ${line} && nvm alias default ${line}`;
  if (/\/AppData\/(Roaming|Local)\/nvm\//i.test(path)) return `nvm install ${line} && nvm use ${line}`;
  if (/\/\.?volta\//i.test(path)) return `volta install node@${line}`;
  if (/fnm/i.test(path)) return `fnm install ${line} && fnm default ${line}`;
  const brew = path.match(/\/Cellar\/(node(?:@\d+)?)\//);
  if (brew) {
    const formula = brew[1] === 'node' || FIXED_IN[major] ? brew[1] : `node@${line}`;
    return formula === brew[1] ? `brew upgrade ${formula}` : `brew install ${formula}`;
  }
  return `download Node.js ${line} from https://nodejs.org`;
}

export function unpatchedNodeMessage(version: string = process.versions.node): string {
  return (
    `Node.js v${version} trusts the compromised eMudhra certificates, so a network attacker could ` +
    `intercept One's traffic and your API key. The One CLI requires Node.js ${REQUIRED_NODE} ` +
    `(Node 18, 20, 23 and 25 never got the fix).`
  );
}

/**
 * Exits with an error on an unpatched Node; returns on a patched one. In agent
 * mode the error is JSON on stdout with a code agents can act on. With
 * ONE_ALLOW_UNPATCHED_NODE=1 it warns and returns instead (silently in agent
 * mode, where stderr would corrupt the JSON for harnesses that merge streams).
 */
export function requirePatchedNode(): void {
  if (nodeHasTlsFix()) return;
  const message = unpatchedNodeMessage();
  const upgrade = upgradeCommand();
  const agent = process.argv.includes('--agent') || process.env.ONE_AGENT === '1';

  if (process.env[ALLOW_UNPATCHED_ENV] === '1') {
    if (!agent) process.stderr.write(`Warning: ${message} Running anyway because ${ALLOW_UNPATCHED_ENV}=1.\n`);
    return;
  }

  if (agent) {
    const error = {
      error: `${message} Ask the user to update Node.js: ${upgrade}`,
      code: 'NODE_UPGRADE_REQUIRED',
      currentNode: process.versions.node,
      requiredNode: REQUIRED_NODE_RANGE,
      upgrade,
    };
    process.stdout.write(`${JSON.stringify(error)}\n`);
  } else {
    process.stderr.write(`Error: ${message}\nTo update: ${upgrade}\n`);
  }
  process.exit(1);
}
