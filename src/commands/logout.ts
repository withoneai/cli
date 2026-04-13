import fs from 'node:fs';
import * as p from '@clack/prompts';
import { getApiKey, getGlobalConfigPath } from '../lib/config.js';
import * as output from '../lib/output.js';

export async function logoutCommand(): Promise<void> {
  const apiKey = getApiKey();

  if (!apiKey) {
    if (output.isAgentMode()) {
      output.json({ error: 'Not logged in.' });
      process.exit(1);
    }
    output.error('Not logged in. Run: one login');
    return;
  }

  const configPath = getGlobalConfigPath();
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }

  if (output.isAgentMode()) {
    output.json({ status: 'logged_out', message: 'Local credentials cleared.' });
  } else {
    p.log.success('Local credentials cleared.');
    p.log.info('Your API key is still active. Manage keys at app.withone.ai/settings');
    p.outro('Logged out.');
  }
}
