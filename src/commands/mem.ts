/**
 * `one mem` command surface.
 *
 * Scaffolding stage: subcommands are wired and discoverable via --help, but
 * handlers return a "not implemented yet" message until the backend plugins
 * and orchestration layer land.
 *
 * See docs/plans/unified-memory.md §6 for the full command tree.
 */

import type { Command } from 'commander';
import * as output from '../lib/output.js';
import { listBackendPlugins, getMemoryConfig } from '../lib/memory/index.js';

function scaffoldNote(cmd: string): void {
  const msg = `\`one mem ${cmd}\` is scaffolded but not yet implemented. ` +
    `Follow progress on branch feat/unified-memory (docs/plans/unified-memory.md).`;
  if (output.isAgentMode()) {
    output.json({ status: 'not-implemented', command: cmd, message: msg });
  } else {
    output.note(msg, 'one mem');
  }
}

function memStatusCommand(): void {
  const cfg = getMemoryConfig();
  const plugins = listBackendPlugins().map(p => ({
    name: p.name,
    description: p.description,
    version: p.version,
    schemaVersion: p.schemaVersion,
    capabilities: p.capabilities,
  }));

  const payload = {
    configured: cfg !== null,
    backend: cfg?.backend ?? null,
    embedding: cfg
      ? { provider: cfg.embedding.provider, model: cfg.embedding.model }
      : null,
    registeredPlugins: plugins,
    note: 'Subsystem is scaffolded. Run `one mem init` once implemented to configure.',
  };

  if (output.isAgentMode()) {
    output.json(payload);
    return;
  }

  output.intro('one mem — unified memory subsystem (scaffolding)');
  console.log(`  configured:  ${payload.configured}`);
  console.log(`  backend:     ${payload.backend ?? '(none)'}`);
  console.log(`  embedding:   ${payload.embedding ? `${payload.embedding.provider} / ${payload.embedding.model}` : '(none)'}`);
  console.log(`  plugins:     ${plugins.map(p => `${p.name}@${p.version}`).join(', ')}`);
  console.log('');
  console.log('  ℹ  Subsystem is scaffolded. Not yet wired for live use.');
}

export function registerMemoryCommands(program: Command): void {
  const mem = program.command('mem').description('Unified memory (notes, decisions, synced data) — all pluggable backends');

  mem.command('status')
    .description('Show memory subsystem status, config, and registered backend plugins')
    .action(memStatusCommand);

  mem.command('init')
    .description('Interactive setup: backend, path, embedding provider + key')
    .action(() => scaffoldNote('init'));

  mem.command('config [action] [key] [value]')
    .description('Get or set memory config (backend, embedding provider, etc.)')
    .action(() => scaffoldNote('config'));

  mem.command('migrate')
    .description('Import legacy .one/sync/data/*.db files into the unified store')
    .action(() => scaffoldNote('migrate'));

  mem.command('doctor')
    .description('Diagnose schema, indexes, plugin resolution, connectivity')
    .action(() => scaffoldNote('doctor'));

  // Records
  mem.command('add <type> <data>')
    .description('Add a new memory record')
    .action(() => scaffoldNote('add'));

  mem.command('get <id>')
    .description('Get a record by id')
    .action(() => scaffoldNote('get'));

  mem.command('update <id> <patch>')
    .description('Update a record')
    .action(() => scaffoldNote('update'));

  mem.command('archive <id>')
    .description('Archive a record')
    .action(() => scaffoldNote('archive'));

  mem.command('weight <id> <n>')
    .description('Set record relevance weight (1-10)')
    .action(() => scaffoldNote('weight'));

  mem.command('flush <id>')
    .description('Reset access count for a record')
    .action(() => scaffoldNote('flush'));

  mem.command('list <type>')
    .description('List records of a given type')
    .action(() => scaffoldNote('list'));

  // Search
  mem.command('search <query>')
    .description('Hybrid search (FTS + optional semantic) across all records')
    .action(() => scaffoldNote('search'));

  mem.command('context')
    .description('Get the most relevant records for startup context')
    .action(() => scaffoldNote('context'));

  // Graph
  mem.command('link <fromId> <toId> <relation>')
    .description('Create a typed link between records')
    .action(() => scaffoldNote('link'));

  mem.command('unlink <fromId> <toId> <relation>')
    .description('Remove a link')
    .action(() => scaffoldNote('unlink'));

  mem.command('linked <id>')
    .description('List linked records')
    .action(() => scaffoldNote('linked'));

  // Sources (replaces old external-refs concept)
  mem.command('sources <id>')
    .description('List source entries on a record')
    .action(() => scaffoldNote('sources'));

  mem.command('find-by-source <sourceKey>')
    .description('Look up the record owning a "<system>/<model>:<external_id>" source key')
    .action(() => scaffoldNote('find-by-source'));

  // Sync subverb (absorbed)
  const sync = mem.command('sync').description('Sync platform data into memory');
  sync.command('run <platform>').description('Sync a platform').action(() => scaffoldNote('sync run'));
  sync.command('list [platform]').description('List synced platforms + freshness').action(() => scaffoldNote('sync list'));
  sync.command('query <type>').description('Structured query against synced records').action(() => scaffoldNote('sync query'));
  sync.command('search <query>').description('Fast FTS-only search across synced records').action(() => scaffoldNote('sync search'));
  sync.command('profile [action]').description('Manage sync profiles').action(() => scaffoldNote('sync profile'));
  sync.command('schedule [action]').description('Manage recurring syncs').action(() => scaffoldNote('sync schedule'));

  // Maintenance
  mem.command('vacuum').description('Backend maintenance').action(() => scaffoldNote('vacuum'));
  mem.command('reindex').description('Re-embed all records under a (possibly new) embedding model').action(() => scaffoldNote('reindex'));
  mem.command('export [outfile]').description('Export records as JSON').action(() => scaffoldNote('export'));
  mem.command('import <file>').description('Import records from JSON').action(() => scaffoldNote('import'));
}
