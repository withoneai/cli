import * as p from '@clack/prompts';
import pc from 'picocolors';
import path from 'node:path';
import type { McpInstallResult } from '../lib/agents.js';

/**
 * Shown after any project-scope MCP install. Project config files hold the
 * installer's own API key, so they are git-ignored and must not be shared.
 */
export function noteProjectMcp(results: McpInstallResult[]): void {
  if (results.length === 0) return;
  p.note(
    pc.yellow('These files contain your One API key. They are added to .gitignore\n') +
    pc.yellow('and readable only by you. Do not commit or share them; each team\n') +
    pc.yellow('member should run `one init` to set up MCP with their own key.'),
    'Tip',
  );
  const committed = results.filter(r => r.committed);
  if (committed.length > 0) {
    const rel = committed.map(r => path.relative(process.cwd(), r.configPath) || r.configPath);
    p.log.warn(
      `Already tracked by git, so .gitignore does not protect ${rel.length === 1 ? 'it' : 'them'}: ${rel.join(', ')}.\n` +
      `Remove ${rel.length === 1 ? 'it' : 'them'} from the repository with \`git rm --cached ${rel.join(' ')}\`, ` +
      `and rotate your API key if ${rel.length === 1 ? 'it was' : 'they were'} ever pushed.`,
    );
  }
}
