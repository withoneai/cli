import http from 'node:http';
import crypto from 'node:crypto';
import open from 'open';
import * as p from '@clack/prompts';
import { OneApi, ApiError } from '../lib/api.js';
import { getApiKey, resolveConfig, saveCredentials, getApiBase, getEnvFromApiKey, type ConfigScope } from '../lib/config.js';
import { getCliAuthUrl } from '../lib/browser.js';
import { collectInstallContext, describeInstallContext } from '../lib/install-context.js';
import * as output from '../lib/output.js';
import type { WhoAmIResponse } from '../lib/types.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PORT_RANGE_START = 49152;
const PORT_RANGE_END = 65535;
const MAX_PORT_ATTEMPTS = 5;
/** Matches the cap the consent page puts on its key-name field. */
const MAX_KEY_NAME_LENGTH = 120;
const MAX_ERROR_LENGTH = 200;
const CHECK_MARK = `<div style="width:48px;height:48px;border-radius:50%;background:rgba(34,197,94,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
<svg width="24" height="24" fill="none" stroke="#22c55e" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
</div>`;

/** The page the browser lands on after the callback. Copy is fixed, never user input. */
function statusPage(title: string, body: string, check = false): string {
  return `<!DOCTYPE html>
<html><head><title>One CLI</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa">
<div style="text-align:center">
${check ? CHECK_MARK : ''}
<h1 style="font-size:20px;margin:0 0 8px">${title}</h1>
<p style="color:#a1a1aa;font-size:14px">${body}</p>
</div></body></html>`;
}
const SUCCESS_HTML = statusPage("You're all set!", 'Return to your terminal. You can close this tab.', true);
const CANCELLED_HTML = statusPage('Login cancelled', 'No key was created. You can close this tab and run <code>one login</code> again.');
const FAILED_HTML = statusPage('Login did not complete', 'The consent page reported an error. Return to your terminal for details, then run <code>one login</code> again.');

/** What the browser consent page reported back on the localhost callback. */
export type CallbackOutcome =
  | { kind: 'key'; apiKey: string; keyName?: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

/**
 * A query value that is about to be printed and stored: control characters
 * out, whitespace trimmed, length bounded. Undefined when nothing is left.
 */
function cleanParam(value: string | null, max: number): string | undefined {
  if (value === null) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!cleaned) return undefined;
  return Array.from(cleaned).slice(0, max).join('');
}

function randomPort(): number {
  return PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
}

export function startCallbackServer(
  expectedState: string
): Promise<{ server: http.Server; port: number; result: Promise<CallbackOutcome> }> {
  return new Promise((resolveSetup, rejectSetup) => {
    let attempts = 0;

    function tryListen() {
      const port = randomPort();
      attempts++;

      let resolveResult: (value: CallbackOutcome) => void;
      const result = new Promise<CallbackOutcome>((res) => {
        resolveResult = res;
      });

      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);

        if (url.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const state = url.searchParams.get('state');
        if (!state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing state');
          return;
        }
        if (state !== expectedState) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('State mismatch');
          return;
        }

        // A key wins over anything else on the query: once the page has
        // minted one, the CLI must store it rather than orphan it.
        const encodedKey = url.searchParams.get('s');
        if (encodedKey) {
          const apiKey = Buffer.from(encodedKey, 'base64').toString('utf-8');
          if (!apiKey) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing required parameters');
            return;
          }
          const keyName = cleanParam(url.searchParams.get('name'), MAX_KEY_NAME_LENGTH);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(SUCCESS_HTML);
          resolveResult({ kind: 'key', apiKey, keyName });
          return;
        }

        // The page reports a cancel with ?error=cancelled so the CLI can stop
        // waiting instead of sitting out the 5-minute timeout. Any other
        // value is a failure the page could not show inline; it reaches the
        // terminal so the user learns why instead of reading "cancelled".
        const error = cleanParam(url.searchParams.get('error'), MAX_ERROR_LENGTH);
        if (error === 'cancelled') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(CANCELLED_HTML);
          resolveResult({ kind: 'cancelled' });
          return;
        }
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(FAILED_HTML);
          resolveResult({ kind: 'failed', reason: error });
          return;
        }

        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing required parameters');
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        // EACCES: Windows reserves whole port ranges for Hyper-V and WinNAT
        // and refuses to bind inside them, which surfaces as a permission
        // error rather than a busy port. Both mean "try another port".
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempts < MAX_PORT_ATTEMPTS) {
          tryListen();
          return;
        }
        rejectSetup(err);
      });

      server.listen(port, '127.0.0.1', () => {
        resolveSetup({ server, port, result });
      });
    }

    tryListen();
  });
}

// ── Reusable browser auth flow ──────────────────────────────────────
// Returns { apiKey, whoami, keyName } on success, null on failure/cancel.
// Handles the local callback server, browser open, and whoami validation.
// Does NOT handle credential saving or post-login UX. The caller names the
// scope because the consent page records it (and the project path) on the
// key it mints.

export interface BrowserLoginOptions {
  /** Where the credentials will be stored; the page records it as a tag. */
  scope: ConfigScope;
}

export interface BrowserLoginResult {
  apiKey: string;
  whoami: WhoAmIResponse;
  /** Name the consent page gave the key, when the page sent one. */
  keyName?: string;
}

export async function browserLogin(opts: BrowserLoginOptions): Promise<BrowserLoginResult | null> {
  const state = crypto.randomUUID();
  const spin = output.createSpinner();

  let server: http.Server;
  let port: number;
  let resultPromise: Promise<CallbackOutcome>;

  try {
    ({ server, port, result: resultPromise } = await startCallbackServer(state));
  } catch {
    output.error('Could not start local server. Try: one init');
    return null;
  }

  const context = collectInstallContext({ scope: opts.scope });
  const authUrl = getCliAuthUrl(port, state, context);

  // Agent mode keeps stdout clean for the final JSON document, but the URL
  // still has to reach a person in case the browser does not open.
  if (output.isAgentMode()) {
    process.stderr.write(`Opening the browser for authentication. If it doesn't open, visit:\n${authUrl}\n`);
  } else {
    output.note(
      `If the browser doesn't open, visit:\n${authUrl}\n\nThe consent page records this on the key so you can find the install later:\n${describeInstallContext(context)}`,
      'Opening browser for authentication...'
    );
  }

  try {
    await open(authUrl);
  } catch {
    // Browser open failed — URL is already displayed above
  }

  spin.start('Waiting for authentication... (timeout: 5 min)');

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, LOGIN_TIMEOUT_MS);
    timer.unref();
  });

  try {
    const outcome = await Promise.race([resultPromise, timeout]);
    if (outcome.kind === 'cancelled') {
      spin.stop('Login cancelled in the browser.');
      return null;
    }
    if (outcome.kind === 'failed') {
      spin.stop('Authentication failed.');
      output.error(`The consent page reported an error: ${outcome.reason}. Try again with: one login`);
    }
    spin.stop('Authentication received!');

    // Fetch whoami
    const apiBase = getApiBase();
    const api = new OneApi(outcome.apiKey, apiBase);
    const whoami = await api.whoami();

    return { apiKey: outcome.apiKey, whoami, keyName: outcome.keyName };
  } catch (err) {
    spin.stop('Authentication failed.');
    if (err instanceof Error && err.message === 'timeout') {
      output.error('Authentication timed out (5 min). Try again with: one login');
    } else if (err instanceof ApiError) {
      output.error(`Authentication failed: ${err.message}`);
    } else {
      output.error('Authentication failed. Try: one init');
    }
    return null;
  } finally {
    server!.closeAllConnections();
    server!.close();
  }
}

// ── Standalone login command ────────────────────────────────────────

export async function loginCommand(): Promise<void> {
  if (output.isAgentMode()) {
    output.json({ error: 'Browser login not available in agent mode. Use: one init' });
    return;
  }

  // Determine login scope
  let targetScope: ConfigScope = 'global';
  const existingKey = getApiKey();

  if (existingKey) {
    // Show current session info (same format as `one whoami`)
    const pc = (await import('picocolors')).default;
    const resolved = resolveConfig();
    const whoami = resolved.config?.whoami;
    const env = getEnvFromApiKey(existingKey);
    const envLabel = env === 'test' ? pc.yellow('test') : pc.green('live');
    const currentScope = resolved.scope === 'project'
      ? pc.cyan('local config')
      : pc.magenta('global config');

    const lines: string[] = ['You are already logged in.', ''];
    if (whoami) {
      const contextParts: string[] = [];
      if (whoami.organization) contextParts.push(whoami.organization.name);
      if (whoami.project) contextParts.push(whoami.project.name);
      const scopeDisplay = contextParts.length > 0 ? contextParts.join(' / ') : 'Personal';
      lines.push(`${pc.bold(scopeDisplay)} ${pc.dim('·')} ${envLabel}`);
      lines.push(`${whoami.user.name} ${pc.dim(`(${whoami.user.email})`)}`);
      if (whoami.organization) lines.push(`${pc.dim('Org:')} ${whoami.organization.name}`);
      if (whoami.project) lines.push(`${pc.dim('Project:')} ${whoami.project.name}`);
    }
    lines.push('');
    lines.push(`${pc.dim('Stored in')} ${currentScope}`);
    p.note(lines.join('\n'));

    // Let user pick scope for new login
    const scopeChoice = await p.select({
      message: 'Where would you like to log in?',
      options: [
        { value: 'global', label: 'Globally', hint: 'applies everywhere' },
        { value: 'project', label: 'This directory', hint: 'only this project' },
      ],
    });
    if (p.isCancel(scopeChoice)) {
      p.cancel('Login cancelled.');
      return;
    }
    targetScope = scopeChoice as ConfigScope;
  }

  // Run browser auth
  const result = await browserLogin({ scope: targetScope });
  if (!result) return;

  const { apiKey, whoami, keyName } = result;
  saveCredentials(apiKey, targetScope, { keyName, whoami });

  // Display result
  const pc = (await import('picocolors')).default;
  const env = getEnvFromApiKey(apiKey);
  const contextParts: string[] = [];
  if (whoami.organization) contextParts.push(whoami.organization.name);
  if (whoami.project) contextParts.push(whoami.project.name);
  const scopeDisplay = contextParts.length > 0 ? contextParts.join(' / ') : 'Personal';
  const envLabel = env === 'test' ? pc.yellow('test') : pc.green('live');
  const configLabel = targetScope === 'project'
    ? pc.cyan('local config')
    : pc.magenta('global config');

  const infoLines = [
    `${pc.bold(scopeDisplay)} ${pc.dim('·')} ${envLabel}`,
    `${whoami.user.name} ${pc.dim(`(${whoami.user.email})`)}`,
  ];
  if (keyName) infoLines.push(`${pc.dim('Key:')} ${keyName}`);
  if (whoami.organization) infoLines.push(`${pc.dim('Org:')} ${whoami.organization.name}`);
  if (whoami.project) infoLines.push(`${pc.dim('Project:')} ${whoami.project.name}`);
  infoLines.push('');
  infoLines.push(`${pc.dim('Stored in')} ${configLabel}`);
  p.note(infoLines.join('\n'), 'Logged in');

  console.log();
  console.log(`  ${pc.dim('Next steps:')}`);
  console.log(`  ${pc.cyan('one add <platform>')}  ${pc.dim('—')} Connect a platform (e.g. gmail, slack, stripe)`);
  console.log();
  console.log(pc.bold('  Copy-paste this to your AI agent:'));
  console.log();
  console.log(pc.cyan('  ┌─────────────────────────────────────────────────────────────'));
  console.log(pc.cyan('  │'));
  console.log(pc.cyan('  │  The One CLI (`one`) is now installed on this machine. It'));
  console.log(pc.cyan('  │  lets you interact with 600+ third-party platforms (Gmail,'));
  console.log(pc.cyan('  │  Slack, Shopify, HubSpot, Stripe, GitHub, etc.) through'));
  console.log(pc.cyan('  │  their APIs. Whenever you need to interact with any'));
  console.log(pc.cyan('  │  third-party platform or external service, use the `one`'));
  console.log(pc.cyan('  │  skill. Please save this to your project instructions or'));
  console.log(pc.cyan('  │  memory so you remember it in future conversations.'));
  console.log(pc.cyan('  │'));
  console.log(pc.cyan('  └─────────────────────────────────────────────────────────────'));
  console.log();
  p.outro('Happy building!');
}
