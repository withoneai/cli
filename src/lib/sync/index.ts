import type { Command } from 'commander';
import * as output from '../output.js';
import { OneApi } from '../api.js';
import { getApiKey, getAccessControlFromAllSources } from '../config.js';
import { discoverModels } from './models.js';
import { readProfile, writeProfile, listProfiles, removeProfile, generateTemplate } from './profile.js';
import { syncModel } from './runner.js';
import { readSyncState, removeModelState, getModelState } from './state.js';
import { executeQuery, executeRawSql } from './query.js';
import { searchSyncedData } from './search.js';
import { openDatabase, getDatabaseSize, dropTable, deleteDatabase, countRecords, listTables, deleteRecords, rebuildFtsIndex, tableExists } from './db.js';
import type { SyncProfile, SyncRunOptions, SyncQueryOptions } from './types.js';
import * as p from '@clack/prompts';
import pc from 'picocolors';

function getApi(): OneApi {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('No API key configured. Run "one init" first.');
  }
  return new OneApi(apiKey);
}

// ── sync models ──

async function syncModelsCommand(platform: string): Promise<void> {
  const api = getApi();
  const spinner = output.createSpinner();
  spinner.start(`Discovering models for ${platform}...`);

  try {
    const models = await discoverModels(api, platform);
    spinner.stop(`Found ${models.length} models`);

    if (output.isAgentMode()) {
      output.json({ platform, models, total: models.length });
      return;
    }

    if (models.length === 0) {
      output.note('No list-type actions found for this platform.', 'Models');
      return;
    }

    const lines = models.map(m =>
      `  ${pc.bold(m.name.padEnd(30))} ${pc.dim(m.listAction.method)} ${pc.dim(m.listAction.path)}`
    );
    output.note(lines.join('\n'), `${platform} — ${models.length} models`);
  } catch (err) {
    spinner.stop('Failed');
    output.error(`Error discovering models: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync init ──

async function syncInitCommand(platform: string, model: string, options: { config?: string }): Promise<void> {
  if (!options.config) {
    // Output a template with resolved executable action ID
    const api = getApi();
    const spinner = output.createSpinner();
    spinner.start(`Looking up ${platform}/${model}...`);

    try {
      // Find the model in available actions
      const models = await discoverModels(api, platform);
      const match = models.find(m => m.name === model || m.name.toLowerCase() === model.toLowerCase());

      // Try to resolve the executable action ID via search
      let actionId: string | undefined;
      if (match) {
        spinner.stop('Found model, resolving action...');
        const searchSpinner = output.createSpinner();
        searchSpinner.start('Searching for executable action...');
        try {
          const searchResults = await api.searchActions(platform, match.displayName, 'execute');
          const resolved = searchResults.find(
            a => a.path === match.listAction.path && a.method === match.listAction.method
          );
          actionId = resolved?.systemId;
          searchSpinner.stop(actionId ? 'Found executable action' : 'Could not auto-resolve action ID');
        } catch {
          searchSpinner.stop('Search failed — fill in actionId manually');
        }
      } else {
        spinner.stop('Model not found in available actions');
      }

      const template = generateTemplate(platform, model, actionId);

      // Add a hint about next steps
      const hint = actionId
        ? `Action ID resolved. Next: read knowledge, then fill in resultsPath, idField, and pagination.`
        : `Action ID not resolved. Run: one --agent actions search ${platform} "list ${model}" -t execute`;

      if (output.isAgentMode()) {
        output.json({ ...template, _hint: hint });
      } else {
        output.note(JSON.stringify(template, null, 2), 'Sync profile template');
        console.log(`\n${hint}`);
        console.log(`\nRun with --config to save:\n  one sync init ${platform} ${model} --config '${JSON.stringify(template)}'`);
      }
    } catch (err) {
      spinner.stop('Failed');
      output.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // Parse and save config
  let profile: SyncProfile;
  try {
    profile = JSON.parse(options.config) as SyncProfile;
  } catch {
    output.error('Invalid JSON in --config. Provide a valid JSON sync profile.');
    return;
  }

  // Ensure platform/model from args override whatever is in the JSON
  profile.platform = platform;
  profile.model = model;

  try {
    writeProfile(profile);
    if (output.isAgentMode()) {
      output.json({ status: 'created', platform, model, profile });
    } else {
      output.outro(`Sync profile saved for ${platform}/${model}`);
    }
  } catch (err) {
    output.error(`Error saving profile: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync run ──

async function syncRunCommand(platform: string, options: SyncRunOptions): Promise<void> {
  const api = getApi();
  const profiles = listProfiles(platform);
  const targetModels = options.models;

  const toSync = targetModels
    ? profiles.filter(p => targetModels.includes(p.model))
    : profiles;

  if (toSync.length === 0) {
    output.error(
      `No sync profiles found for ${platform}` +
      (targetModels ? ` with models: ${targetModels.join(', ')}` : '') +
      `. Run 'one sync init ${platform} <model> --config ...' first.`
    );
  }

  const results = [];
  for (const profile of toSync) {
    try {
      const result = await syncModel(api, profile, options);
      results.push(result);
    } catch (err) {
      results.push({
        model: profile.model,
        recordsSynced: 0,
        pagesProcessed: 0,
        duration: '0s',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (output.isAgentMode()) {
    output.json({ platform, results });
    return;
  }

  // Human output
  for (const r of results) {
    const status = r.status === 'complete'
      ? pc.green('complete')
      : r.status === 'dry-run'
        ? pc.yellow('dry-run')
        : pc.red('failed');
    console.log(`  ${pc.bold(r.model)} — ${r.recordsSynced} records, ${r.pagesProcessed} pages, ${r.duration} [${status}]`);
    if ('error' in r && r.error) {
      console.log(`    ${pc.red(r.error as string)}`);
    }
  }
}

// ── sync query ──

async function syncQueryCommand(platformModel: string, options: SyncQueryOptions): Promise<void> {
  const [platform, model] = platformModel.split('/');
  if (!platform || !model) {
    output.error('Usage: one sync query <platform>/<model>. Example: one sync query shopify/orders');
  }

  // Handle --refresh
  if (options.refresh) {
    const api = getApi();
    const profile = readProfile(platform, model);
    if (profile) {
      if (!output.isAgentMode()) {
        process.stderr.write(`Refreshing ${platform}/${model}...\n`);
      }
      await syncModel(api, profile, { force: options.refreshForce });
    }
  }

  try {
    const result = executeQuery(platform, model, options);
    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    console.log(pc.dim(`Query: ${result.query}`));
    console.log(pc.dim(`Source: local | Last sync: ${result.lastSync ?? 'never'} | Age: ${result.syncAge ?? 'n/a'}`));
    console.log(JSON.stringify(result.results, null, 2));
    console.log(`\n${result.total} results`);
  } catch (err) {
    output.error(`Query error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync search ──

async function syncSearchCommand(query: string, options: { platform?: string; models?: string; limit?: string }): Promise<void> {
  const modelList = options.models?.split(',').map(m => m.trim());
  const limit = options.limit ? parseInt(options.limit, 10) : 20;

  try {
    const result = searchSyncedData(query, { platform: options.platform, models: modelList, limit });
    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    if (result.results.length === 0) {
      output.note('No results found.', 'Search');
      return;
    }

    for (const r of result.results) {
      console.log(`  ${pc.bold(`${r.platform}/${r.model}`)} ${pc.dim(`(rank: ${r.rank.toFixed(2)})`)}`);
      console.log(`    ${JSON.stringify(r.record)}`);
    }
    console.log(`\n${result.total} results`);
  } catch (err) {
    output.error(`Search error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync sql ──

async function syncSqlCommand(platform: string, sql: string): Promise<void> {
  try {
    const result = executeRawSql(platform, sql);
    if (output.isAgentMode()) {
      output.json({ platform, ...result, total: result.results.length });
      return;
    }

    console.log(JSON.stringify(result.results, null, 2));
    console.log(`\n${result.results.length} rows`);
  } catch (err) {
    output.error(`SQL error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync delete ──

async function syncDeleteCommand(platformModel: string, options: { where?: string; id?: string; yes?: boolean }): Promise<void> {
  const [platform, model] = platformModel.split('/');
  if (!platform || !model) {
    output.error('Usage: one sync delete <platform>/<model> --id <id> or --where "field=value"');
  }

  if (!options.id && !options.where) {
    output.error('Provide --id <value> or --where "field=value" to specify which records to delete.');
  }

  const db = openDatabase(platform);
  try {
    if (!tableExists(db, model)) {
      db.close();
      output.error(`No synced data for ${platform}/${model}.`);
    }

    // Build WHERE clause
    let where: string;
    let params: unknown[];

    if (options.id) {
      // Find the idField from the profile
      const profile = readProfile(platform, model);
      const idField = profile?.idField || 'id';
      where = `"${idField}" = ?`;
      params = [options.id];
    } else {
      // Parse --where conditions (reuse query parsing)
      const conditions = options.where!.split(',').map(c => c.trim());
      const clauses: string[] = [];
      params = [];
      for (const cond of conditions) {
        const match = cond.match(/^(.+?)\s*(>=|<=|!=|>|<|=)\s*(.+)$/);
        if (!match) {
          db.close();
          output.error(`Cannot parse condition: "${cond}". Use field=value format.`);
        }
        clauses.push(`"${match[1].trim()}" ${match[2]} ?`);
        params.push(match[3].trim());
      }
      where = clauses.join(' AND ');
    }

    // Preview what will be deleted
    const preview = db.prepare(`SELECT COUNT(*) as count FROM "${model}" WHERE ${where}`).get(...params) as { count: number };

    if (preview.count === 0) {
      db.close();
      if (output.isAgentMode()) {
        output.json({ deleted: 0, platform, model });
      } else {
        console.log('No matching records found.');
      }
      return;
    }

    // Confirm unless --yes
    if (!options.yes && !output.isAgentMode()) {
      const confirmed = await p.confirm({ message: `Delete ${preview.count} record(s) from ${platform}/${model}?` });
      if (p.isCancel(confirmed) || !confirmed) {
        db.close();
        output.cancel('Cancelled.');
        return;
      }
    }

    const deleted = deleteRecords(db, model, where, params);

    // Rebuild FTS index
    rebuildFtsIndex(db, model);

    db.close();

    if (output.isAgentMode()) {
      output.json({ deleted, platform, model });
    } else {
      console.log(`Deleted ${deleted} record(s) from ${platform}/${model}.`);
    }
  } catch (err) {
    db.close();
    output.error(`Delete error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── sync list ──

async function syncListCommand(platform?: string): Promise<void> {
  const profiles = listProfiles(platform);
  const state = readSyncState();

  const syncs = profiles.map(p => {
    const modelState = state[p.platform]?.[p.model];
    return {
      platform: p.platform,
      model: p.model,
      lastSync: modelState?.lastSync ?? null,
      totalRecords: modelState?.totalRecords ?? 0,
      dbSize: getDatabaseSize(p.platform),
      status: modelState?.status ?? 'idle',
    };
  });

  if (output.isAgentMode()) {
    output.json({ syncs });
    return;
  }

  if (syncs.length === 0) {
    output.note('No sync profiles configured.', 'Sync');
    return;
  }

  for (const s of syncs) {
    const status = s.status === 'idle'
      ? pc.green('idle')
      : s.status === 'syncing'
        ? pc.yellow('syncing')
        : pc.red('failed');
    console.log(
      `  ${pc.bold(`${s.platform}/${s.model}`.padEnd(35))} ` +
      `${String(s.totalRecords).padStart(8)} records  ` +
      `${s.dbSize.padStart(10)}  ` +
      `${status}  ` +
      `${pc.dim(s.lastSync ? `last: ${s.lastSync}` : 'never synced')}`
    );
  }
}

// ── sync remove ──

async function syncRemoveCommand(platform: string, options: { models?: string; yes?: boolean }): Promise<void> {
  const modelList = options.models?.split(',').map(m => m.trim());

  // Confirm unless --yes
  if (!options.yes && !output.isAgentMode()) {
    const target = modelList
      ? `${platform}/${modelList.join(', ')}`
      : `all synced data for ${platform}`;
    const confirmed = await p.confirm({ message: `Remove ${target}?` });
    if (p.isCancel(confirmed) || !confirmed) {
      output.cancel('Cancelled.');
      return;
    }
  }

  try {
    if (modelList) {
      const db = openDatabase(platform);
      for (const model of modelList) {
        dropTable(db, model);
        removeProfile(platform, model);
        removeModelState(platform, model);
      }
      db.close();
    } else {
      // Remove everything for this platform
      const profiles = listProfiles(platform);
      for (const prof of profiles) {
        removeProfile(prof.platform, prof.model);
      }
      deleteDatabase(platform);
      removeModelState(platform);
    }

    if (output.isAgentMode()) {
      output.json({ status: 'removed', platform, models: modelList ?? 'all' });
    } else {
      output.outro(`Removed sync data for ${platform}${modelList ? `/${modelList.join(', ')}` : ''}`);
    }
  } catch (err) {
    output.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Register all sync commands ──

export function registerSyncCommands(program: Command): void {
  const sync = program
    .command('sync')
    .alias('s')
    .description('Sync platform data locally for instant offline queries');

  sync
    .command('models <platform>')
    .description('Discover available data models for a platform')
    .action(async (platform: string) => {
      await syncModelsCommand(platform);
    });

  sync
    .command('init <platform> <model>')
    .description('Create or update a sync profile for a model')
    .option('--config <json>', 'Sync profile configuration as JSON')
    .action(async (platform: string, model: string, options: { config?: string }) => {
      await syncInitCommand(platform, model, options);
    });

  sync
    .command('run <platform>')
    .description('Run sync for a platform (syncs all configured models, or specify --models)')
    .option('--models <models>', 'Comma-separated list of models to sync')
    .option('--since <duration>', 'Sync records since duration (e.g. 90d, 30d, 7d) or date')
    .option('--force', 'Ignore existing sync state and start fresh')
    .option('--max-pages <n>', 'Maximum number of pages to fetch')
    .option('--dry-run', 'Fetch first page only, show results without persisting')
    .action(async (platform: string, options: { models?: string; since?: string; force?: boolean; maxPages?: string; dryRun?: boolean }) => {
      await syncRunCommand(platform, {
        models: options.models?.split(',').map(m => m.trim()),
        since: options.since,
        force: options.force,
        maxPages: options.maxPages ? parseInt(options.maxPages, 10) : undefined,
        dryRun: options.dryRun,
      });
    });

  sync
    .command('query <platform/model>')
    .description('Query local synced data (e.g. one sync query shopify/orders --where "status=unfulfilled")')
    .option('--where <conditions>', 'Filter conditions (e.g. "status=active,plan=pro")')
    .option('--after <date>', 'Records after this date')
    .option('--before <date>', 'Records before this date')
    .option('--limit <n>', 'Max results (default: 50)')
    .option('--order-by <field>', 'Sort by field')
    .option('--order <dir>', 'Sort direction: asc or desc')
    .option('--refresh', 'Trigger incremental sync before querying')
    .option('--refresh-force', 'Trigger full re-sync before querying (implies --refresh)')
    .option('--date-field <field>', 'Specify date column for --after/--before')
    .action(async (platformModel: string, options: any) => {
      await syncQueryCommand(platformModel, {
        where: options.where,
        after: options.after,
        before: options.before,
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        orderBy: options.orderBy,
        order: options.order,
        refresh: options.refresh || options.refreshForce,
        refreshForce: options.refreshForce,
        dateField: options.dateField,
      });
    });

  sync
    .command('search <query>')
    .description('Full-text search across all synced data (or filter by --platform / --models)')
    .option('--platform <platform>', 'Search only this platform (default: all)')
    .option('--models <models>', 'Comma-separated list of models to search')
    .option('--limit <n>', 'Max results (default: 20)')
    .action(async (query: string, options: { platform?: string; models?: string; limit?: string }) => {
      await syncSearchCommand(query, options);
    });

  sync
    .command('sql <platform> <sql>')
    .description('Execute raw SQL against local sync database (SELECT only)')
    .action(async (platform: string, sql: string) => {
      await syncSqlCommand(platform, sql);
    });

  sync
    .command('delete <platform/model>')
    .description('Delete records from local sync data (e.g. one sync delete notion/pages --id "abc-123")')
    .option('--id <value>', 'Delete record by ID')
    .option('--where <conditions>', 'Delete records matching conditions (e.g. "status=archived")')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (platformModel: string, options: { id?: string; where?: string; yes?: boolean }) => {
      await syncDeleteCommand(platformModel, options);
    });

  sync
    .command('list [platform]')
    .alias('ls')
    .description('List all configured sync profiles and their status')
    .action(async (platform?: string) => {
      await syncListCommand(platform);
    });

  sync
    .command('remove <platform>')
    .description('Remove sync data and profiles for a platform')
    .option('--models <models>', 'Specific models to remove (comma-separated)')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (platform: string, options: { models?: string; yes?: boolean }) => {
      await syncRemoveCommand(platform, options);
    });
}
