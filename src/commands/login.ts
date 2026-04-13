import http from 'node:http';
import crypto from 'node:crypto';
import * as p from '@clack/prompts';
import { OneApi, ApiError } from '../lib/api.js';
import { getApiKey, writeConfig, readConfig, getApiBase } from '../lib/config.js';
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
  userEmail?: string;
  userName?: string;
}): void {
  const existing = readConfig();
  writeConfig({
    apiKey: opts.apiKey,
    keyId: opts.keyId,
    userEmail: opts.userEmail,
    userName: opts.userName,
    installedAgents: existing?.installedAgents ?? [],
    createdAt: new Date().toISOString(),
    accessControl: existing?.accessControl,
    cacheTtl: existing?.cacheTtl,
    apiBase: existing?.apiBase,
  }, 'global');
}

interface CallbackPayload {
  apiKey: string;
  keyId: string;
  state: string;
  userEmail?: string;
  userName?: string;
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

        const apiKey = url.searchParams.get('apiKey');
        const keyId = url.searchParams.get('keyId') || '';
        const state = url.searchParams.get('state');
        const userEmail = url.searchParams.get('userEmail') || undefined;
        const userName = url.searchParams.get('userName') || undefined;

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
        resolveResult({ apiKey, keyId, state, userEmail, userName });
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

export async function loginCommand(options: { key?: string }): Promise<void> {
  // --key flag: manual key input
  if (options.key) {
    await loginWithKey(options.key);
    return;
  }

  // Check if already logged in
  const existingKey = getApiKey();
  if (existingKey) {
    if (output.isAgentMode()) {
      output.json({ status: 'already_authenticated', message: 'Already logged in. Use --key to update.' });
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
    output.json({ error: 'Browser login not available in agent mode. Use: one login --key <api-key>' });
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
    output.error('Could not start local server. Try: one login --key <api-key>');
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

    const displayName = payload.userName || payload.userEmail || 'Unknown';

    saveCredentials({
      apiKey: payload.apiKey,
      keyId: payload.keyId,
      userEmail: payload.userEmail,
      userName: payload.userName,
    });

    if (displayName !== 'Unknown') {
      p.log.success(`Authenticated as ${displayName}${payload.userEmail ? ` (${payload.userEmail})` : ''}`);
    }
    p.log.success('API key stored in ~/.one/config.json');
    p.outro('You\'re all set!');
  } catch (err) {
    spin.stop('Authentication failed.');
    if (err instanceof Error && err.message === 'timeout') {
      output.error('Authentication timed out (5 min). Try again with: one login');
    } else if (err instanceof ApiError) {
      output.error(`Authentication failed: ${err.message}`);
    } else {
      output.error('Authentication failed. Try: one login --key <api-key>');
    }
  } finally {
    server!.close();
  }
}

async function loginWithKey(key: string): Promise<void> {
  // Validate format
  if (!key.startsWith('sk_live_') && !key.startsWith('sk_test_')) {
    output.error('Invalid key format. Keys start with sk_live_ or sk_test_');
    return;
  }

  if (!output.isAgentMode()) {
    const spin = p.spinner();
    spin.start('Validating API key...');

    try {
      const apiBase = getApiBase();
      const api = new OneApi(key, apiBase);
      const isValid = await api.validateApiKey();
      if (!isValid) throw new ApiError(401, 'Invalid API key');
      spin.stop('Key validated!');

      saveCredentials({ apiKey: key });

      p.log.success('API key stored in ~/.one/config.json');
      p.outro('You\'re all set!');
    } catch (err) {
      spin.stop('Validation failed.');
      if (err instanceof ApiError && err.status === 401) {
        output.error('Invalid API key. Check your key and try again.');
      } else {
        output.error('Could not validate key. Check your network connection.');
      }
    }
  } else {
    try {
      const apiBase = getApiBase();
      const api = new OneApi(key, apiBase);
      await api.validateApiKey();

      saveCredentials({ apiKey: key });

      output.json({ status: 'authenticated', message: 'API key stored successfully.' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        output.json({ error: 'Invalid API key.' });
      } else {
        output.json({ error: 'Could not validate key.' });
      }
      process.exit(1);
    }
  }
}
