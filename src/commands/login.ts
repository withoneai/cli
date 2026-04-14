import http from 'node:http';
import crypto from 'node:crypto';
import * as p from '@clack/prompts';
import { OneApi, ApiError } from '../lib/api.js';
import { getApiKey, writeConfig, resolveConfig, getApiBase, getEnvFromApiKey } from '../lib/config.js';
import { getCliAuthUrl, openCliAuthPage } from '../lib/browser.js';
import * as output from '../lib/output.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PORT_RANGE_START = 49152;
const PORT_RANGE_END = 65535;
const MAX_PORT_ATTEMPTS = 5;
const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>One CLI</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa">
<div style="text-align:center">
<div style="width:48px;height:48px;border-radius:50%;background:rgba(34,197,94,0.1);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
<svg width="24" height="24" fill="none" stroke="#22c55e" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
</div>
<h1 style="font-size:20px;margin:0 0 8px">You're all set!</h1>
<p style="color:#a1a1aa;font-size:14px">Return to your terminal. You can close this tab.</p>
</div></body></html>`;

function saveCredentials(opts: {
  apiKey: string;
  keyId?: string;
}): void {
  const resolved = resolveConfig();
  const scope = resolved.scope ?? 'global';
  const existing = resolved.config;
  writeConfig({
    apiKey: opts.apiKey,
    keyId: opts.keyId,
    installedAgents: existing?.installedAgents ?? [],
    createdAt: new Date().toISOString(),
    accessControl: existing?.accessControl,
    cacheTtl: existing?.cacheTtl,
    apiBase: existing?.apiBase,
  }, scope);
}

interface CallbackPayload {
  apiKey: string;
  keyId: string;
  state: string;
}

function randomPort(): number {
  return PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
}

function startCallbackServer(
  expectedState: string
): Promise<{ server: http.Server; port: number; result: Promise<CallbackPayload> }> {
  return new Promise((resolveSetup, rejectSetup) => {
    let attempts = 0;

    function tryListen() {
      const port = randomPort();
      attempts++;

      let resolveResult: (value: CallbackPayload) => void;
      const result = new Promise<CallbackPayload>((res) => {
        resolveResult = res;
      });

      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);

        if (url.pathname !== '/callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const encodedKey = url.searchParams.get('s');
        const keyId = url.searchParams.get('k') || '';
        const state = url.searchParams.get('state');

        const apiKey = encodedKey ? Buffer.from(encodedKey, 'base64').toString('utf-8') : null;

        if (!apiKey || !state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing required parameters');
          return;
        }

        if (state !== expectedState) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('State mismatch');
          return;
        }

        // Serve success page to the browser
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        resolveResult({ apiKey, keyId, state });
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempts < MAX_PORT_ATTEMPTS) {
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

export async function loginCommand(): Promise<void> {
  // Check if already logged in
  const existingKey = getApiKey();
  if (existingKey) {
    if (output.isAgentMode()) {
      output.json({ status: 'already_authenticated', message: 'Already logged in. Run one init to update key manually.' });
      return;
    }
    const shouldOverwrite = await p.confirm({
      message: 'You are already logged in. Overwrite with new credentials?',
    });
    if (p.isCancel(shouldOverwrite) || !shouldOverwrite) {
      p.cancel('Login cancelled.');
      return;
    }
  }

  const state = crypto.randomUUID();

  if (output.isAgentMode()) {
    output.json({ error: 'Browser login not available in agent mode. Use: one init' });
    return;
  }

  const spin = p.spinner();

  // Start localhost callback server
  let server: http.Server;
  let port: number;
  let resultPromise: Promise<CallbackPayload>;

  try {
    ({ server, port, result: resultPromise } = await startCallbackServer(state));
  } catch (err) {
    output.error('Could not start local server. Try: one init');
    return;
  }

  const authUrl = getCliAuthUrl(port, state);

  p.note(
    `If the browser doesn't open, visit:\n${authUrl}`,
    'Opening browser for authentication...'
  );

  // Open browser
  try {
    await openCliAuthPage(port, state);
  } catch {
    // Browser open failed — URL is already displayed above
  }

  spin.start('Waiting for authentication... (timeout: 5 min)');

  // Wait for callback or timeout
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, LOGIN_TIMEOUT_MS);
    // Allow process to exit if the timeout is the only thing keeping it alive
    timer.unref();
  });

  try {
    const payload = await Promise.race([resultPromise, timeout]);
    spin.stop('Authentication received!');

    // Save key first
    saveCredentials({ apiKey: payload.apiKey, keyId: payload.keyId });

    // Call whoami to get user info and store it
    const apiBase = getApiBase();
    const api = new OneApi(payload.apiKey, apiBase);
    const whoami = await api.whoami();

    // Update config with whoami data
    const resolved = resolveConfig();
    if (resolved.config) {
      writeConfig({ ...resolved.config, whoami }, resolved.scope ?? 'global');
    }

    // Display in same format as `one whoami`
    const pc = (await import('picocolors')).default;
    const env = getEnvFromApiKey(payload.apiKey);
    const contextParts: string[] = [];
    if (whoami.organization) contextParts.push(whoami.organization.name);
    if (whoami.project) contextParts.push(whoami.project.name);
    const scopeDisplay = contextParts.length > 0 ? contextParts.join(' / ') : 'Personal';
    const envLabel = env === 'test' ? pc.yellow('test') : pc.green('live');
    const configLabel = resolved.scope === 'project'
      ? pc.cyan('project config')
      : pc.magenta('global config');

    console.log();
    console.log(`  ${pc.bold(scopeDisplay)} ${pc.dim('·')} ${envLabel}`);
    console.log(`  ${whoami.user.name} ${pc.dim(`(${whoami.user.email})`)}`);
    if (whoami.organization) console.log(`  ${pc.dim('Org:')} ${whoami.organization.name}`);
    if (whoami.project) console.log(`  ${pc.dim('Project:')} ${whoami.project.name}`);
    console.log();
    console.log(`  ${pc.dim('Stored in')} ${configLabel}`);
    p.outro('Run `one whoami` for full details.');
  } catch (err) {
    spin.stop('Authentication failed.');
    if (err instanceof Error && err.message === 'timeout') {
      output.error('Authentication timed out (5 min). Try again with: one login');
    } else if (err instanceof ApiError) {
      output.error(`Authentication failed: ${err.message}`);
    } else {
      output.error('Authentication failed. Try: one init');
    }
  } finally {
    server!.close();
  }
}
