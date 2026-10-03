import * as p from '@clack/prompts';

let _agentMode = false;

export function setAgentMode(value: boolean): void {
  _agentMode = value;
}

export function isAgentMode(): boolean {
  return _agentMode || process.env.ONE_AGENT === '1';
}

/**
 * In agent mode, machine consumers parse the CLI's output as JSON. Node (and
 * some dependencies) emit process warnings — e.g. the "Fetch API is an
 * experimental feature" ExperimentalWarning on older Node, or `Readable.fromWeb`
 * during a binary download — via `process.emitWarning`. Harnesses that merge
 * stdout+stderr then see those lines interleaved with the JSON response and
 * fail to parse it (#88). Silence them when `--agent` is active.
 *
 * Detected straight from argv/env (not the `setAgentMode()` flag) so it can run
 * at process startup, before the first warning fires and before commander has
 * parsed the flag. A no-op in interactive/human mode — warnings still show.
 */
export function silenceWarningsInAgentMode(): void {
  const agent = process.argv.includes('--agent') || process.env.ONE_AGENT === '1';
  if (!agent) return;
  // Belt: respected by any child processes the CLI spawns.
  process.env.NODE_NO_WARNINGS = '1';
  // Suspenders: silence warnings emitted by *this* process after startup.
  process.removeAllListeners('warning');
  process.emitWarning = (() => {}) as typeof process.emitWarning;
}

/** Columns a spinner frame needs around its message: the glyph, two spaces and up to three dots. */
const SPINNER_CHROME = 6;

/**
 * `msg` cut to fit one terminal row as a spinner frame. Clack redraws a frame
 * by clearing only the row the cursor is on, so a frame that wraps leaves its
 * first row behind on every tick and the message piles up down the screen.
 */
export function fitSpinnerMessage(msg: string, columns: number | undefined): string {
  if (!columns || columns <= 0) return msg;
  const room = columns - SPINNER_CHROME;
  const chars = Array.from(msg);
  if (chars.length <= room) return msg;
  return room > 1 ? `${chars.slice(0, room - 1).join('')}…` : '';
}

export function createSpinner(): { start(msg: string): void; stop(msg: string): void } {
  if (isAgentMode()) {
    return { start() {}, stop() {} };
  }
  // Without a terminal there is no redrawing in place, so every animation
  // frame would be appended to the output: print each message once instead.
  if (!process.stdout.isTTY) {
    return {
      start: (msg) => p.log.step(msg),
      stop: (msg) => p.log.message(msg),
    };
  }
  const spinner = p.spinner();
  return {
    start: (msg) => spinner.start(fitSpinnerMessage(msg, process.stdout.columns)),
    stop: (msg) => spinner.stop(msg),
  };
}

export function intro(msg: string): void {
  if (!isAgentMode()) p.intro(msg);
}

export function outro(msg: string): void {
  if (!isAgentMode()) p.outro(msg);
}

export function note(msg: string, title?: string): void {
  if (!isAgentMode()) p.note(msg, title);
}

export function cancel(msg: string): void {
  if (!isAgentMode()) p.cancel(msg);
}

export function json(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

export function error(message: string, exitCode = 1): never {
  if (isAgentMode()) {
    json({ error: message });
  } else {
    p.cancel(message);
  }
  process.exit(exitCode);
}
