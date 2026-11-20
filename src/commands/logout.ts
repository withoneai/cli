import fs from 'node:fs';
import * as p from '@clack/prompts';
import {
  getApiKey,
  readGlobalConfig,
  readProjectConfig,
  getGlobalConfigPath,
  getProjectConfigPath,
  getEnvFromApiKey,
} from '../lib/config.js';
import * as output from '../lib/output.js';
import type { Config } from '../lib/types.js';

function formatWhoami(config: Config, apiKey: string, pc: typeof import('picocolors')): string[] {
  const whoami = config.whoami;
  const env = getEnvFromApiKey(apiKey);
  const envLabel = env === 'test' ? pc.yellow('test') : pc.green('live');
  const lines: string[] = [];

  if (whoami) {
    const contextParts: string[] = [];
    if (whoami.organization) contextParts.push(whoami.organization.name);
    if (whoami.project) contextParts.push(whoami.project.name);
    const scopeDisplay = contextParts.length > 0 ? contextParts.join(' / ') : 'Personal';
    lines.push(`${pc.bold(scopeDisplay)} ${pc.dim('·')} ${envLabel}`);
    lines.push(`${whoami.user.name} ${pc.dim(`(${whoami.user.email})`)}`);
    if (config.apiKeyName) lines.push(`${pc.dim('Key:')} ${config.apiKeyName}`);
  } else {
    // No cached account record (cleared by `one config` or a base change):
    // the stored name still says which key this is, better than a prefix.
    const keyLabel = config.apiKeyName ?? `${apiKey.slice(0, 8)}...`;
    lines.push(`${pc.dim('Key:')} ${keyLabel} ${pc.dim('·')} ${envLabel}`);
  }

  return lines;
}

type ConfigScope = 'project' | 'global';
export type LogoutScope = ConfigScope | 'both';
const LOGOUT_SCOPES: readonly LogoutScope[] = ['project', 'global', 'both'];

/**
 * Which config files a logout clears. With no `--scope`, only the config in
 * effect: the project config when there is one (it wins resolution), else the
 * global one. `both` is opt-in. Paths are null when that file doesn't exist.
 */
export function resolveLogoutTargets(opts: {
  scope?: string;
  projectPath: string | null;
  globalPath: string | null;
}): { targets: Array<{ scope: ConfigScope; path: string }> } | { error: string } {
  const { scope, projectPath, globalPath } = opts;
  if (scope !== undefined && !LOGOUT_SCOPES.includes(scope as LogoutScope)) {
    return { error: `Unknown --scope "${scope}". Use project, global or both.` };
  }
  const project = projectPath ? [{ scope: 'project' as const, path: projectPath }] : [];
  const global = globalPath ? [{ scope: 'global' as const, path: globalPath }] : [];
  if (scope === 'both') return { targets: [...project, ...global] };
  if (scope === 'project' || scope === 'global') {
    const found = scope === 'project' ? project : global;
    if (found.length === 0) return { error: `There is no ${scope} config to clear.` };
    return { targets: found };
  }
  return { targets: project.length > 0 ? project : global };
}

const LOGOUT_CONFIRMATION_HINT =
  'Re-run with --force to clear these credentials. This deletes the whole config file, ' +
  'including the OpenAI key, access control and memory settings. ' +
  'Pass --scope project|global|both to choose which config.';

export async function logoutCommand(options: { force?: boolean; scope?: string } = {}): Promise<void> {
  const apiKey = getApiKey();

  if (!apiKey) {
    if (output.isAgentMode()) {
      output.json({ error: 'Not logged in.' });
      process.exit(1);
    }
    output.error('Not logged in. Run: one login');
    return;
  }

  if (output.isAgentMode()) {
    // Agent mode: no prompts, so deleting needs --force (as `connection delete`
    // does), and only the config in effect is cleared unless --scope says so.
    const projectPath = getProjectConfigPath();
    const globalPath = getGlobalConfigPath();
    const plan = resolveLogoutTargets({
      scope: options.scope,
      projectPath: fs.existsSync(projectPath) ? projectPath : null,
      globalPath: fs.existsSync(globalPath) ? globalPath : null,
    });
    if ('error' in plan) {
      output.json({ error: plan.error });
      process.exit(1);
    }
    if (plan.targets.length === 0) {
      output.json({
        status: 'not_logged_in',
        message: 'No config file found. The key comes from ONE_SECRET or .onerc; remove it there.',
      });
      return;
    }
    if (!options.force) {
      output.json({
        status: 'confirmation_required',
        error: 'Logging out needs --force in agent mode.',
        wouldClear: plan.targets,
        _hint: LOGOUT_CONFIRMATION_HINT,
      });
      process.exit(1);
    }
    for (const t of plan.targets) fs.unlinkSync(t.path);
    output.json({
      status: 'logged_out',
      cleared: plan.targets,
      message: 'Credentials cleared. The API key itself stays active; revoke it in the dashboard.',
    });
    return;
  }

  const pc = (await import('picocolors')).default;
  const globalConfig = readGlobalConfig();
  const projectConfig = readProjectConfig();
  const hasGlobal = globalConfig?.apiKey != null;
  const hasProject = projectConfig?.apiKey != null;

  // Build scope options based on what exists
  type LogoutScope = 'global' | 'project' | 'both';
  let targetScope: LogoutScope;

  if (hasGlobal && hasProject) {
    // Both exist — let user choose
    const infoLines = ['You are logged in with multiple configs.', ''];
    if (projectConfig) {
      infoLines.push(`${pc.cyan('Local config:')}`);
      infoLines.push(...formatWhoami(projectConfig, projectConfig.apiKey, pc));
      infoLines.push('');
    }
    if (globalConfig) {
      infoLines.push(`${pc.magenta('Global config:')}`);
      infoLines.push(...formatWhoami(globalConfig, globalConfig.apiKey, pc));
    }
    p.note(infoLines.join('\n'));

    const choice = await p.select({
      message: 'What would you like to log out of?',
      options: [
        { value: 'project', label: 'This directory', hint: 'local config only' },
        { value: 'global', label: 'Globally', hint: 'global config only' },
        { value: 'both', label: 'Both', hint: 'remove all credentials' },
      ],
    });
    if (p.isCancel(choice)) {
      p.cancel('Logout cancelled.');
      return;
    }
    targetScope = choice as LogoutScope;
  } else if (hasProject) {
    const infoLines = ['You are logged in.', ''];
    infoLines.push(`${pc.dim('Stored in')} ${pc.cyan('local config')}`);
    infoLines.push(...formatWhoami(projectConfig!, projectConfig!.apiKey, pc));
    p.note(infoLines.join('\n'));
    targetScope = 'project';
  } else if (hasGlobal) {
    const infoLines = ['You are logged in.', ''];
    infoLines.push(`${pc.dim('Stored in')} ${pc.magenta('global config')}`);
    infoLines.push(...formatWhoami(globalConfig!, globalConfig!.apiKey, pc));
    p.note(infoLines.join('\n'));
    targetScope = 'global';
  } else {
    // Key comes from env var or .onerc — no config file to delete
    p.log.warn('Credentials are set via environment variable or .onerc, not a config file.');
    p.log.info('Remove the ONE_SECRET variable from your environment or .onerc file.');
    p.outro('Nothing to remove.');
    return;
  }

  // Confirm
  const scopeLabels: Record<LogoutScope, string> = {
    project: 'local',
    global: 'global',
    both: 'all',
  };
  const confirm = await p.confirm({
    message: `Remove ${scopeLabels[targetScope]} credentials?`,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.cancel('Logout cancelled.');
    return;
  }

  // Delete
  if (targetScope === 'project' || targetScope === 'both') {
    const projectPath = getProjectConfigPath();
    if (fs.existsSync(projectPath)) fs.unlinkSync(projectPath);
  }
  if (targetScope === 'global' || targetScope === 'both') {
    const globalPath = getGlobalConfigPath();
    if (fs.existsSync(globalPath)) fs.unlinkSync(globalPath);
  }

  p.log.success('Credentials cleared.');
  p.log.info('Your API key is still active. Manage keys at app.withone.ai/settings');
  p.outro('Logged out.');
}
