import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { getAllAgents, installMcpConfig, getAgentConfigPath, supportsProjectScope } from './agents.js';
import { withTempHome } from '../test-support/home.js';

// Agent MCP configs hold the One API key in plain text. They must be readable
// by the owner only, and project-scope files must be kept out of git.

const KEY = 'sk_test_dummy_key_for_mcp_config';
const posix = process.platform !== 'win32';
const mode = (p: string) => fs.statSync(p).mode & 0o777;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('MCP config files that hold the API key', () => {
  const home = withTempHome('one-mcp-secret-');
  let project: string;
  let savedCwd: string;
  let savedUmask: number;

  beforeEach(() => {
    home.setup();
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'one-mcp-proj-'));
    savedCwd = process.cwd();
    process.chdir(project);
    savedUmask = process.umask(0o022);
  });
  afterEach(() => {
    process.umask(savedUmask);
    process.chdir(savedCwd);
    fs.rmSync(project, { recursive: true, force: true });
    home.teardown();
  });

  const projectAgents = () => getAllAgents().filter(supportsProjectScope);

  it('creates project config files readable by the owner only', { skip: !posix }, () => {
    for (const agent of projectAgents()) {
      const { configPath } = installMcpConfig(agent, KEY, 'project');
      assert.equal(mode(configPath), 0o600, `${agent.id}: ${configPath}`);
    }
  });

  it('leaves global config permissions as they were', { skip: !posix }, () => {
    const agent = getAllAgents().find(a => a.id === 'claude-code')!;
    const configPath = getAgentConfigPath(agent, 'global');
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark' }));
    fs.chmodSync(configPath, 0o644);
    installMcpConfig(agent, KEY, 'global');
    assert.equal(mode(configPath), 0o644);
    assert.ok(!fs.existsSync(path.join(project, '.gitignore')), 'global install touched .gitignore');
  });

  it('tightens an existing world-readable project config and keeps its other settings', { skip: !posix }, () => {
    const agent = getAllAgents().find(a => a.id === 'claude-code')!;
    const configPath = getAgentConfigPath(agent, 'project');
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark' }));
    fs.chmodSync(configPath, 0o644);
    installMcpConfig(agent, KEY, 'project');
    assert.equal(mode(configPath), 0o600);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf-8')).theme, 'dark');
  });

  it('adds every project config path to .gitignore once', () => {
    fs.writeFileSync('.gitignore', 'node_modules');
    for (const agent of projectAgents()) installMcpConfig(agent, KEY, 'project');
    for (const agent of projectAgents()) installMcpConfig(agent, KEY, 'project');
    const lines = fs.readFileSync('.gitignore', 'utf-8').split('\n');
    assert.equal(lines[0], 'node_modules');
    for (const agent of projectAgents()) {
      const entry = `/${agent.projectConfigPath!.split(path.sep).join('/')}`;
      assert.equal(lines.filter(l => l === entry).length, 1, entry);
    }
  });

  it('git sees the project configs as ignored', () => {
    git(project, 'init', '-q');
    for (const agent of projectAgents()) {
      const { committed } = installMcpConfig(agent, KEY, 'project');
      assert.equal(committed, false);
    }
    git(project, 'add', '-A');
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: project, encoding: 'utf-8' });
    assert.deepEqual(staged.trim().split('\n'), ['.gitignore']);
  });

  it('reports a project config that is already committed', () => {
    git(project, 'init', '-q');
    const agent = getAllAgents().find(a => a.id === 'claude-code')!;
    fs.writeFileSync('.mcp.json', '{}');
    git(project, 'add', '.mcp.json');
    git(project, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'add');
    const result = installMcpConfig(agent, KEY, 'project');
    assert.equal(result.committed, true);
  });

  it('does not write through a symlinked .gitignore', { skip: !posix }, () => {
    const outside = path.join(home.dir, 'outside.txt');
    fs.writeFileSync(outside, 'untouched\n');
    fs.symlinkSync(outside, '.gitignore');
    const agent = getAllAgents().find(a => a.id === 'claude-code')!;
    installMcpConfig(agent, KEY, 'project');
    assert.equal(fs.readFileSync(outside, 'utf-8'), 'untouched\n');
  });
});
