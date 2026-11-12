import { homeDir } from './home.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { Agent, AccessControlSettings } from './types.js';

export type InstallScope = 'global' | 'project';

function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(homeDir(), p.slice(2));
  }
  return p;
}

function getClaudeDesktopConfigPath(): string {
  switch (process.platform) {
    case 'darwin':
      return '~/Library/Application Support/Claude/claude_desktop_config.json';
    case 'win32':
      return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
    default:
      return '~/.config/Claude/claude_desktop_config.json';
  }
}

function getClaudeDesktopDetectDir(): string {
  switch (process.platform) {
    case 'darwin':
      return '~/Library/Application Support/Claude';
    case 'win32':
      return path.join(process.env.APPDATA || '', 'Claude');
    default:
      return '~/.config/Claude';
  }
}

function getWindsurfConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(homeDir(), '.codeium', 'windsurf', 'mcp_config.json');
  }
  return '~/.codeium/windsurf/mcp_config.json';
}

function getWindsurfDetectDir(): string {
  if (process.platform === 'win32') {
    return path.join(homeDir(), '.codeium', 'windsurf');
  }
  return '~/.codeium/windsurf';
}

function getCursorConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(homeDir(), '.cursor', 'mcp.json');
  }
  return '~/.cursor/mcp.json';
}

/**
 * Built per call, never bound at module load.
 *
 * On win32 the Windsurf/Cursor/Claude-Desktop helpers return absolute paths
 * (built from homeDir(), or from %APPDATA%), while on POSIX they return lazy
 * `~/...` strings that expandPath() resolves at use time. A module-scope array
 * therefore captured the real home on Windows at import — the exact
 * platform-asymmetric trap that let the test suite write to the developer's
 * real home. Keep this a function. (see lib/home.ts)
 */
function getAgents(): Agent[] {
  return [
  {
    id: 'claude-code',
    name: 'Claude Code',
    configPath: '~/.claude.json',
    configKey: 'mcpServers',
    detectDir: '~/.claude',
    projectConfigPath: '.mcp.json',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    configPath: getClaudeDesktopConfigPath(),
    configKey: 'mcpServers',
    detectDir: getClaudeDesktopDetectDir(),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    configPath: getCursorConfigPath(),
    configKey: 'mcpServers',
    detectDir: '~/.cursor',
    projectConfigPath: '.cursor/mcp.json',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    configPath: getWindsurfConfigPath(),
    configKey: 'mcpServers',
    detectDir: getWindsurfDetectDir(),
  },
  {
    id: 'codex',
    name: 'Codex',
    configPath: '~/.codex/config.toml',
    configKey: 'mcp_servers',
    detectDir: '~/.codex',
    projectConfigPath: '.codex/config.toml',
    configFormat: 'toml',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    configPath: '~/.kiro/settings/mcp.json',
    configKey: 'mcpServers',
    detectDir: '~/.kiro',
    projectConfigPath: '.kiro/settings/mcp.json',
  },
  ];
}

export function getAllAgents(): Agent[] {
  return getAgents();
}

export function detectInstalledAgents(): Agent[] {
  return getAgents().filter(agent => {
    const detectDir = expandPath(agent.detectDir);
    return fs.existsSync(detectDir);
  });
}

export function supportsProjectScope(agent: Agent): boolean {
  return agent.projectConfigPath !== undefined;
}

export function getAgentConfigPath(agent: Agent, scope: InstallScope = 'global'): string {
  if (scope === 'project' && agent.projectConfigPath) {
    return path.join(process.cwd(), agent.projectConfigPath);
  }
  return expandPath(agent.configPath);
}

export function readAgentConfig(agent: Agent, scope: InstallScope = 'global'): Record<string, unknown> {
  const configPath = getAgentConfigPath(agent, scope);
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    if (agent.configFormat === 'toml') {
      return parseToml(content) as Record<string, unknown>;
    }
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function writeAgentConfig(agent: Agent, config: Record<string, unknown>, scope: InstallScope = 'global'): void {
  const configPath = getAgentConfigPath(agent, scope);
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const body = agent.configFormat === 'toml' ? stringifyToml(config) : JSON.stringify(config, null, 2);
  // Agent configs hold the One API key in plain text, so they are readable by
  // the owner only. `mode` covers a new file; chmod tightens an existing one,
  // which writeFileSync leaves at its old mode.
  fs.writeFileSync(configPath, body, { mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(configPath, 0o600); } catch { /* not ours to chmod; leave it */ }
  }
}

export function getMcpServerConfig(apiKey: string, accessControl?: AccessControlSettings): Record<string, unknown> {
  const env: Record<string, string> = {
    ONE_SECRET: apiKey,
  };

  if (accessControl) {
    if (accessControl.permissions && accessControl.permissions !== 'admin') {
      env.ONE_PERMISSIONS = accessControl.permissions;
    }
    if (accessControl.connectionKeys && !(accessControl.connectionKeys.length === 1 && accessControl.connectionKeys[0] === '*')) {
      env.ONE_CONNECTION_KEYS = accessControl.connectionKeys.join(',');
    }
    if (accessControl.actionIds && !(accessControl.actionIds.length === 1 && accessControl.actionIds[0] === '*')) {
      env.ONE_ACTION_IDS = accessControl.actionIds.join(',');
    }
    if (accessControl.knowledgeAgent) {
      env.ONE_KNOWLEDGE_AGENT = 'true';
    }
  }

  return {
    command: 'npx',
    args: ['-y', '@withone/mcp'],
    env,
  };
}

export interface McpInstallResult {
  configPath: string;
  /**
   * Project scope only: the config file is already tracked by git, so the
   * .gitignore entry does not stop it (and the key in it) from being committed.
   */
  committed: boolean;
}

export function installMcpConfig(agent: Agent, apiKey: string, scope: InstallScope = 'global', accessControl?: AccessControlSettings): McpInstallResult {
  const config = readAgentConfig(agent, scope);
  const configKey = agent.configKey;

  const mcpServers = (config[configKey] as Record<string, unknown>) || {};
  mcpServers['one'] = getMcpServerConfig(apiKey, accessControl);

  config[configKey] = mcpServers;
  writeAgentConfig(agent, config, scope);

  const configPath = getAgentConfigPath(agent, scope);
  if (scope !== 'project' || !agent.projectConfigPath) {
    return { configPath, committed: false };
  }
  // A project config holds the installer's own API key: keep it out of git.
  const root = process.cwd();
  const relPath = agent.projectConfigPath.split(path.sep).join('/');
  ensureGitignored(root, relPath);
  return { configPath, committed: isTrackedByGit(root, relPath) };
}

function runGit(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false; // non-zero exit, not a repository, or git not installed
  }
}

function isTrackedByGit(root: string, relPath: string): boolean {
  return runGit(root, ['ls-files', '--error-unmatch', '--', relPath]);
}

/**
 * Add `/<relPath>` to `<root>/.gitignore` unless git already ignores it.
 * Never writes through a symlinked .gitignore: a cloned repository could
 * point it anywhere on the machine.
 */
export function ensureGitignored(root: string, relPath: string): void {
  if (runGit(root, ['check-ignore', '-q', '--', relPath])) return;

  const gitignore = path.join(root, '.gitignore');
  let existing = '';
  try {
    const st = fs.lstatSync(gitignore);
    if (!st.isFile()) return;
    existing = fs.readFileSync(gitignore, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }

  const lines = existing.split(/\r?\n/).map(l => l.trim());
  if (lines.includes(relPath) || lines.includes(`/${relPath}`)) return;

  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const header = lines.includes('# One MCP config (contains your API key)') ? '' : '# One MCP config (contains your API key)\n';
  fs.appendFileSync(gitignore, `${prefix}${header}/${relPath}\n`);
}

export function isMcpInstalled(agent: Agent, scope: InstallScope = 'global'): boolean {
  const config = readAgentConfig(agent, scope);
  const configKey = agent.configKey;
  const mcpServers = config[configKey] as Record<string, unknown> | undefined;
  return mcpServers?.['one'] !== undefined;
}

export function getProjectConfigPaths(agents: Agent[]): string[] {
  const paths: string[] = [];
  for (const agent of agents) {
    if (agent.projectConfigPath) {
      paths.push(path.join(process.cwd(), agent.projectConfigPath));
    }
  }
  return paths;
}

export interface AgentStatus {
  agent: Agent;
  detected: boolean;
  globalMcp: boolean;
  projectMcp: boolean | null; // null = agent doesn't support project scope
}

export function getAgentStatuses(): AgentStatus[] {
  return getAgents().map(agent => {
    const detected = fs.existsSync(expandPath(agent.detectDir));
    const globalMcp = detected && isMcpInstalled(agent, 'global');
    const projectMcp = agent.projectConfigPath
      ? isMcpInstalled(agent, 'project')
      : null;
    return { agent, detected, globalMcp, projectMcp };
  });
}
