import http from 'node:http';

const PORT_RANGE_START = 49152;
const PORT_RANGE_END = 65535;
const MAX_PORT_ATTEMPTS = 5;
const MAX_ID_LENGTH = 200;
const MAX_ERROR_LENGTH = 200;
/** Catalog ids, UUIDs and client ids: nothing else is written to `.env`. */
const ID_PATTERN = /^[A-Za-z0-9_:.-]+$/;

/** What the setup page reported back once the person approved or left. */
export type ConnectCallbackOutcome =
  | { kind: 'done'; outcome: 'created' | 'updated' | 'unchanged'; clientId: string; permissionSetId: string | null }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

/** The page the browser lands on when the CLI has nothing to send it back
 *  to. Copy is fixed, never user input. */
function statusPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><title>One CLI</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa">
<div style="text-align:center">
<h1 style="font-size:20px;margin:0 0 8px">${title}</h1>
<p style="color:#a1a1aa;font-size:14px">${body}</p>
</div></body></html>`;
}
const CANCELLED_HTML = statusPage('Nothing was changed', 'You can close this tab and run <code>one connect create</code> again.');
const FAILED_HTML = statusPage("The app wasn't set up", 'Return to your terminal for details.');

function cleanId(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length <= MAX_ID_LENGTH && ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

function cleanText(value: string | null): string | undefined {
  if (value === null) return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return cleaned ? Array.from(cleaned).slice(0, MAX_ERROR_LENGTH).join('') : undefined;
}

/**
 * Reads one `/callback` request from the setup page. Pure, so the server
 * stays a thin shell around it: a wrong or missing state is refused, ids
 * that aren't plain ids are refused, and anything else is a failure the
 * terminal should report.
 */
export function parseConnectCallback(
  url: URL,
  expectedState: string
): { status: number; outcome?: ConnectCallbackOutcome } {
  if (url.pathname !== '/callback') return { status: 404 };
  const state = url.searchParams.get('state');
  if (!state) return { status: 400 };
  if (state !== expectedState) return { status: 403 };

  const error = cleanText(url.searchParams.get('error'));
  if (error === 'cancelled') return { status: 200, outcome: { kind: 'cancelled' } };
  if (error) return { status: 200, outcome: { kind: 'failed', reason: error } };

  const outcome = url.searchParams.get('outcome');
  const clientId = cleanId(url.searchParams.get('clientId'));
  const rawSet = url.searchParams.get('permissionSetId');
  const permissionSetId = rawSet ? cleanId(rawSet) : null;
  if (
    (outcome !== 'created' && outcome !== 'updated' && outcome !== 'unchanged') ||
    !clientId ||
    permissionSetId === undefined
  ) {
    return { status: 400 };
  }
  return { status: 200, outcome: { kind: 'done', outcome, clientId, permissionSetId } };
}

function randomPort(): number {
  return PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
}

/**
 * Listens on 127.0.0.1 for the setup page's one callback, as `one login`
 * does. On success the browser is sent to `doneUrl(outcome)` (the page's
 * own summary); a cancel or a failure gets a short page of its own.
 */
export function startConnectCallbackServer(
  expectedState: string,
  doneUrl: (outcome: Extract<ConnectCallbackOutcome, { kind: 'done' }>) => string
): Promise<{ server: http.Server; port: number; result: Promise<ConnectCallbackOutcome> }> {
  return new Promise((resolveSetup, rejectSetup) => {
    let attempts = 0;
    let resolveResult: (value: ConnectCallbackOutcome) => void;
    const result = new Promise<ConnectCallbackOutcome>((res) => {
      resolveResult = res;
    });

    function tryListen() {
      const port = randomPort();
      attempts++;
      const server = http.createServer((req, res) => {
        const { status, outcome } = parseConnectCallback(new URL(req.url || '/', `http://localhost:${port}`), expectedState);
        if (!outcome) {
          res.writeHead(status, { 'Content-Type': 'text/plain' });
          res.end(status === 403 ? 'State mismatch' : status === 404 ? 'Not found' : 'Missing required parameters');
          return;
        }
        if (outcome.kind === 'done') {
          res.writeHead(302, { Location: doneUrl(outcome) });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(outcome.kind === 'cancelled' ? CANCELLED_HTML : FAILED_HTML);
        }
        resolveResult(outcome);
      });

      server.on('error', (err: NodeJS.ErrnoException) => {
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempts < MAX_PORT_ATTEMPTS) {
          tryListen();
          return;
        }
        rejectSetup(err);
      });
      server.listen(port, '127.0.0.1', () => resolveSetup({ server, port, result }));
    }

    tryListen();
  });
}
