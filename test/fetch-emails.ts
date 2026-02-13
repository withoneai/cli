import { PicaApi } from '../src/lib/api.js';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_KEY = 'sk_test_BC52hUz0mFXuiGLeE_Z9hRlYX7nQyE_qGmIFGFS9j-Y';
const ACTION_ID = 'conn_mod_def::GGSNOTZxFUU::ZWXBuJboTpS3Q_U06pF8gA';
const CONNECTION_KEY = 'test::gmail::default::3b4dc96903394a3e8faa41ae5df8a223|user_moe';
const TARGET = 700;
const BATCH_SIZE = 100;

interface Email {
  sender: string;
  receiver: string;
  time: string;
  subject: string;
  body: string;
  messageId: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
}

interface GetEmailsResponse {
  emails: Email[];
  totalFound: number;
  nextPageToken?: string;
  message: string;
}

async function main() {
  const api = new PicaApi(API_KEY);
  const allEmails: Email[] = [];
  let pageToken: string | undefined;
  let batch = 1;

  console.log(`Fetching ${TARGET} emails from Gmail...\n`);

  while (allEmails.length < TARGET) {
    const remaining = TARGET - allEmails.length;
    const count = Math.min(remaining, BATCH_SIZE);

    const data: Record<string, unknown> = {
      connectionKey: CONNECTION_KEY,
      numberOfEmails: count,
    };
    if (pageToken) data.pageToken = pageToken;

    console.log(`Batch ${batch}: fetching ${count} emails (total so far: ${allEmails.length})...`);

    const result = await api.executeAction({
      method: 'POST',
      path: '/gmail/get-emails',
      actionId: ACTION_ID,
      connectionKey: CONNECTION_KEY,
      data,
    }) as GetEmailsResponse;

    const emails = result.emails || [];
    allEmails.push(...emails);
    console.log(`  Got ${emails.length} emails. Total: ${allEmails.length}`);

    pageToken = result.nextPageToken;
    if (!pageToken) {
      console.log('No more pages available.');
      break;
    }

    batch++;
  }

  const outPath = join(__dirname, 'all-emails.json');
  writeFileSync(outPath, JSON.stringify({ emails: allEmails, total: allEmails.length }, null, 2));
  console.log(`\nDone. ${allEmails.length} emails saved to test/all-emails.json`);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
