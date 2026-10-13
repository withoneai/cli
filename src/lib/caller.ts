import { detectLauncher } from './install-context.js';

/**
 * How a call names who made it: for the Logs page's Agent column on a
 * passthrough call (PICA-1017, pica-v2 #992), and for the record of what agents
 * ask a find (pica-v2 #993).
 *
 * `x-one-source: cli` says the call came through the One CLI rather than a
 * script holding the same key. `x-one-agent` names the harness that launched
 * this process (`claude-code`, `cursor`, …) when one did; a person in a plain
 * terminal sends no agent, and the row then shows only the door. Both are
 * declared, never authenticated, and the backend drops a value it cannot
 * read rather than refusing the call, so a wrong value can never break an
 * action. A harness version is not sent: the CLI does not know it, and a
 * made-up one would be shown beside the harness name as if it were real.
 *
 * `x-one-agent-model` names the model the agent says it is running as, which
 * only the agent knows, so it is sent only when the agent passed one
 * (`--ai-model`).
 *
 * The passthrough and find routes read these; every other route ignores them.
 */
export const CALLER_SOURCE_HEADER = 'x-one-source';
export const CALLER_AGENT_HEADER = 'x-one-agent';
export const CALLER_MODEL_HEADER = 'x-one-agent-model';

export function callerHeaders(env: NodeJS.ProcessEnv = process.env, model?: string): Record<string, string> {
  const headers: Record<string, string> = { [CALLER_SOURCE_HEADER]: 'cli' };
  const launcher = detectLauncher(env);
  if (launcher) headers[CALLER_AGENT_HEADER] = launcher;
  const declared = model?.trim();
  if (declared) headers[CALLER_MODEL_HEADER] = declared;
  return headers;
}
