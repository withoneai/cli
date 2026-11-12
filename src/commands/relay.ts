import pc from 'picocolors';
import { getApiKey, getApiBase, getAccessControlFromAllSources } from '../lib/config.js';
import { OneApi } from '../lib/api.js';
import { checkManagementAccess, checkRelayActions, isConnectionAllowed } from '../lib/access-gate.js';
import { resolveActionDetails } from '../lib/action-details.js';
import type { AccessControlSettings } from '../lib/types.js';
import { printTable } from '../lib/table.js';
import * as output from '../lib/output.js';

function getConfig() {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('Not configured. Run `one init` first.');
  }

  const settings = getAccessControlFromAllSources();
  const connectionKeys: string[] = settings.connectionKeys || ['*'];
  return { apiKey, connectionKeys, settings };
}

/**
 * Which relay records the connection allowlist lets this CLI see or change.
 * Relays and events name their connection by id, and the allowlist names
 * keys, so a restricted allowlist costs one connection listing.
 */
async function connectionIdFilter(api: OneApi, settings: AccessControlSettings): Promise<(connectionId: string) => boolean> {
  const keys = settings.connectionKeys ?? ['*'];
  if (keys.includes('*')) return () => true;
  const connections = await api.listConnections();
  const ids = new Set(connections.filter(c => isConnectionAllowed(c.key, keys)).map(c => c.id));
  return id => ids.has(id);
}

function restricted(settings: AccessControlSettings): boolean {
  return !(settings.connectionKeys ?? ['*']).includes('*');
}

/** Loads an endpoint and refuses it when its connection is outside the allowlist. */
async function allowedEndpoint(api: OneApi, settings: AccessControlSettings, id: string): Promise<any> {
  const allowed = await connectionIdFilter(api, settings);
  const endpoint = await api.getRelayEndpoint(id);
  if (!allowed(endpoint.connectionId)) {
    throw new Error(`Relay endpoint "${id}" is on a connection that is not allowed.`);
  }
  return endpoint;
}

/** Loads an event and refuses it when its connection is outside the allowlist. */
async function allowedEvent(api: OneApi, settings: AccessControlSettings, id: string): Promise<any> {
  const allowed = await connectionIdFilter(api, settings);
  const event = await api.getRelayEvent(id);
  if (!allowed(event.connectionId)) {
    throw new Error(`Relay event "${id}" is on a connection that is not allowed.`);
  }
  return event;
}

function actionMethod(api: OneApi): (actionId: string) => Promise<string> {
  return async actionId => (await resolveActionDetails(api, actionId)).details.method;
}

/** Runs a check that may throw, printing its message as a CLI error. */
function guard(check: () => void): void {
  try {
    check();
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
  }
}

function parseJsonArg(value: string, argName: string): any {
  try {
    return JSON.parse(value);
  } catch {
    output.error(`Invalid JSON for ${argName}: ${value}`);
  }
}

// ── Commands ──

export async function relayCreateCommand(options: {
  connectionKey: string;
  description?: string;
  eventFilters?: string;
  tags?: string;
  metadata?: string;
  createWebhook?: boolean;
}): Promise<void> {
  const { apiKey, connectionKeys, settings } = getConfig();

  guard(() => checkManagementAccess(settings, 'write', 'Creating a relay endpoint'));
  if (!connectionKeys.includes('*') && !connectionKeys.includes(options.connectionKey)) {
    output.error(`Connection key "${options.connectionKey}" is not allowed.`);
  }

  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Creating relay endpoint...');

  try {
    const body: Record<string, unknown> = {
      connectionKey: options.connectionKey,
    };
    if (options.description) body.description = options.description;
    if (options.eventFilters) body.eventFilters = parseJsonArg(options.eventFilters, '--event-filters');
    if (options.tags) body.tags = parseJsonArg(options.tags, '--tags');
    if (options.metadata) body.metadata = parseJsonArg(options.metadata, '--metadata');
    if (options.createWebhook) body.createWebhook = true;

    const result = await api.createRelayEndpoint(body as any);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay endpoint created');
    console.log();
    console.log(`  ${pc.dim('ID:')}          ${result.id}`);
    console.log(`  ${pc.dim('URL:')}         ${result.url}`);
    console.log(`  ${pc.dim('Active:')}      ${result.active}`);
    if (result.description) console.log(`  ${pc.dim('Description:')} ${result.description}`);
    if (result.eventFilters?.length) console.log(`  ${pc.dim('Events:')}      ${result.eventFilters.join(', ')}`);
    if (result.webhookPayload?.id) console.log(`  ${pc.dim('Webhook ID:')}  ${result.webhookPayload.id}`);
    if (result.warning) {
      console.log();
      console.log(`  ${pc.yellow('⚠ Warning:')} ${result.warning}`);
    }
    console.log();
  } catch (error) {
    spinner.stop('Failed to create relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayListCommand(options: {
  limit?: string;
  page?: string;
}): Promise<void> {
  const { apiKey, settings } = getConfig();
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Loading relay endpoints...');

  try {
    const query: Record<string, string> = {};
    if (options.limit) query.limit = options.limit;
    if (options.page) query.page = options.page;

    const result = await api.listRelayEndpoints(query);
    const allowed = await connectionIdFilter(api, settings);
    const endpoints = (result.rows || []).filter((e: any) => allowed(e.connectionId));

    if (output.isAgentMode()) {
      output.json({
        // With a connection allowlist the server's total also counts rows
        // the allowlist hides, so report only what is shown.
        total: restricted(settings) ? endpoints.length : result.total,
        showing: endpoints.length,
        endpoints: endpoints.map((e: any) => ({
          id: e.id,
          active: e.active,
          description: e.description,
          eventFilters: e.eventFilters,
          actionsCount: e.actions?.length || 0,
          url: e.url,
          createdAt: e.createdAt,
        })),
      });
      return;
    }

    spinner.stop(`${endpoints.length} relay endpoint${endpoints.length === 1 ? '' : 's'} found`);

    if (endpoints.length === 0) {
      console.log('\n  No relay endpoints yet.\n');
      return;
    }

    printTable(
      [
        { key: 'status', label: '' },
        { key: 'description', label: 'Description' },
        { key: 'events', label: 'Events' },
        { key: 'actions', label: 'Actions' },
        { key: 'id', label: 'ID', color: pc.dim },
      ],
      endpoints.map((e: any) => ({
        status: e.active ? pc.green('●') : pc.dim('○'),
        description: e.description || pc.dim('(none)'),
        events: e.eventFilters?.join(', ') || pc.dim('all'),
        actions: String(e.actions?.length || 0),
        id: e.id.slice(0, 8),
      }))
    );
  } catch (error) {
    spinner.stop('Failed to list relay endpoints');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayGetCommand(id: string): Promise<void> {
  const { apiKey, settings } = getConfig();
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Loading relay endpoint...');

  try {
    const result = await allowedEndpoint(api, settings, id);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay endpoint loaded');
    console.log();
    console.log(`  ${pc.dim('ID:')}          ${result.id}`);
    console.log(`  ${pc.dim('URL:')}         ${result.url}`);
    console.log(`  ${pc.dim('Active:')}      ${result.active}`);
    if (result.description) console.log(`  ${pc.dim('Description:')} ${result.description}`);
    if (result.eventFilters?.length) console.log(`  ${pc.dim('Events:')}      ${result.eventFilters.join(', ')}`);
    console.log(`  ${pc.dim('Actions:')}     ${result.actions?.length || 0}`);
    if (result.actions?.length) {
      for (const [i, action] of result.actions.entries()) {
        console.log(`    ${pc.dim(`[${i}]`)} type=${action.type}${action.actionId ? ` actionId=${action.actionId}` : ''}${action.url ? ` url=${action.url}` : ''}`);
      }
    }
    console.log(`  ${pc.dim('Created:')}     ${result.createdAt}`);
    console.log();
  } catch (error) {
    spinner.stop('Failed to load relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayUpdateCommand(
  id: string,
  options: {
    description?: string;
    active?: boolean;
    eventFilters?: string;
    tags?: string;
    actions?: string;
  }
): Promise<void> {
  const { apiKey, settings } = getConfig();
  guard(() => checkManagementAccess(settings, 'write', 'Updating a relay endpoint'));
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Updating relay endpoint...');

  try {
    const body: Record<string, unknown> = {};
    if (options.description !== undefined) body.description = options.description;
    if (options.active !== undefined) body.active = options.active;
    if (options.eventFilters) body.eventFilters = parseJsonArg(options.eventFilters, '--event-filters');
    if (options.tags) body.tags = parseJsonArg(options.tags, '--tags');
    if (options.actions) body.actions = parseJsonArg(options.actions, '--actions');

    const existing = await allowedEndpoint(api, settings, id);
    // New actions are checked; so are the stored ones when this turns the
    // endpoint on, since they are what will run.
    const effective = body.actions ?? (options.active === true ? existing.actions : undefined);
    await checkRelayActions(settings, effective, actionMethod(api));

    const result = await api.updateRelayEndpoint(id, body);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay endpoint updated');
    console.log(`  ${pc.dim('ID:')} ${result.id}`);
    console.log(`  ${pc.dim('Active:')} ${result.active}`);
    console.log(`  ${pc.dim('Actions:')} ${result.actions?.length || 0}`);
    console.log();
  } catch (error) {
    spinner.stop('Failed to update relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayDeleteCommand(id: string): Promise<void> {
  const { apiKey, settings } = getConfig();
  guard(() => checkManagementAccess(settings, 'delete', 'Deleting a relay endpoint'));
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Deleting relay endpoint...');

  try {
    await allowedEndpoint(api, settings, id);
    const result = await api.deleteRelayEndpoint(id);

    if (output.isAgentMode()) {
      output.json({ deleted: true, id: result.id });
      return;
    }

    spinner.stop('Relay endpoint deleted');
    console.log(`  Deleted: ${result.id}`);
    console.log();
  } catch (error) {
    spinner.stop('Failed to delete relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayActivateCommand(
  id: string,
  options: { actions: string; webhookSecret?: string }
): Promise<void> {
  const { apiKey, settings } = getConfig();
  guard(() => checkManagementAccess(settings, 'write', 'Activating a relay endpoint'));
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Activating relay endpoint...');

  try {
    const actions = parseJsonArg(options.actions, '--actions');
    await allowedEndpoint(api, settings, id);
    await checkRelayActions(settings, actions, actionMethod(api));
    const body: Record<string, unknown> = { actions };
    if (options.webhookSecret) body.webhookSecret = options.webhookSecret;

    const result = await api.activateRelayEndpoint(id, body as any);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay endpoint activated');
    console.log(`  ${pc.dim('ID:')} ${result.id}`);
    console.log(`  ${pc.dim('Active:')} ${result.active}`);
    console.log(`  ${pc.dim('Actions:')} ${result.actions?.length || 0}`);
    console.log();
  } catch (error) {
    spinner.stop('Failed to activate relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayEventsCommand(options: {
  limit?: string;
  page?: string;
  platform?: string;
  eventType?: string;
  after?: string;
  before?: string;
}): Promise<void> {
  const { apiKey, settings } = getConfig();
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Loading relay events...');

  try {
    const query: Record<string, string> = {};
    if (options.limit) query.limit = options.limit;
    if (options.page) query.page = options.page;
    if (options.platform) query.platform = options.platform;
    if (options.eventType) query.eventType = options.eventType;
    if (options.after) query.after = options.after;
    if (options.before) query.before = options.before;

    const result = await api.listRelayEvents(query);
    const allowed = await connectionIdFilter(api, settings);
    const events = (result.rows || []).filter((e: any) => allowed(e.connectionId));

    if (output.isAgentMode()) {
      output.json({
        // With a connection allowlist the server's total also counts rows
        // the allowlist hides, so report only what is shown.
        total: restricted(settings) ? events.length : result.total,
        showing: events.length,
        events: events.map((e: any) => ({
          id: e.id,
          platform: e.platform,
          eventType: e.eventType,
          timestamp: e.timestamp || e.createdAt,
        })),
      });
      return;
    }

    spinner.stop(`${events.length} event${events.length === 1 ? '' : 's'} found`);

    if (events.length === 0) {
      console.log('\n  No events found.\n');
      return;
    }

    printTable(
      [
        { key: 'platform', label: 'Platform' },
        { key: 'eventType', label: 'Event Type' },
        { key: 'timestamp', label: 'Timestamp' },
        { key: 'id', label: 'ID', color: pc.dim },
      ],
      events.map((e: any) => ({
        platform: e.platform,
        eventType: e.eventType || pc.dim('unknown'),
        timestamp: e.timestamp || e.createdAt,
        id: e.id.slice(0, 8),
      }))
    );
  } catch (error) {
    spinner.stop('Failed to list relay events');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayEventGetCommand(id: string): Promise<void> {
  const { apiKey, settings } = getConfig();
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Loading relay event...');

  try {
    const result = await allowedEvent(api, settings, id);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay event loaded');
    console.log();
    console.log(`  ${pc.dim('ID:')}        ${result.id}`);
    console.log(`  ${pc.dim('Platform:')}  ${result.platform}`);
    console.log(`  ${pc.dim('Event:')}     ${result.eventType}`);
    console.log(`  ${pc.dim('Timestamp:')} ${result.timestamp || result.createdAt}`);
    console.log(`  ${pc.dim('Payload:')}`);
    console.log(JSON.stringify(result.payload, null, 2));
    console.log();
  } catch (error) {
    spinner.stop('Failed to load relay event');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayDeliveriesCommand(options: {
  endpointId?: string;
  eventId?: string;
}): Promise<void> {
  if (!options.endpointId && !options.eventId) {
    output.error('Provide either --endpoint-id or --event-id');
  }

  const { apiKey, settings } = getConfig();
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Loading deliveries...');

  try {
    if (options.endpointId) await allowedEndpoint(api, settings, options.endpointId);
    else await allowedEvent(api, settings, options.eventId!);
    const deliveries = options.endpointId
      ? await api.listRelayEndpointDeliveries(options.endpointId)
      : await api.listRelayEventDeliveries(options.eventId!);

    const items = Array.isArray(deliveries) ? deliveries : deliveries.rows || [];

    if (output.isAgentMode()) {
      output.json({ deliveries: items });
      return;
    }

    spinner.stop(`${items.length} deliver${items.length === 1 ? 'y' : 'ies'} found`);

    if (items.length === 0) {
      console.log('\n  No deliveries found.\n');
      return;
    }

    printTable(
      [
        { key: 'status', label: 'Status' },
        { key: 'code', label: 'Code' },
        { key: 'attempt', label: 'Attempt' },
        { key: 'deliveredAt', label: 'Delivered At' },
        { key: 'error', label: 'Error' },
      ],
      items.map((d: any) => ({
        status: d.status === 'success' ? pc.green(d.status) : pc.red(d.status),
        code: d.statusCode != null ? String(d.statusCode) : pc.dim('-'),
        attempt: String(d.attempt),
        deliveredAt: d.deliveredAt || pc.dim('-'),
        error: d.error ? pc.red(d.error.slice(0, 50)) : pc.dim('-'),
      }))
    );
  } catch (error) {
    spinner.stop('Failed to load deliveries');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayPlatformsCommand(): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start('Loading relay-capable platforms...');

  try {
    const platforms = await api.listRelayPlatforms();

    if (output.isAgentMode()) {
      output.json({ platforms });
      return;
    }

    spinner.stop(`${platforms.length} relay-capable platform${platforms.length === 1 ? '' : 's'} found`);

    if (platforms.length === 0) {
      console.log('\n  No relay-capable platforms available.\n');
      return;
    }

    console.log();
    printTable(
      [
        { key: 'platform', label: 'Platform' },
        { key: 'eventTypeCount', label: 'Event types', color: pc.dim },
      ],
      platforms.map(p => ({ platform: p.platform, eventTypeCount: String(p.eventTypeCount) }))
    );
    console.log();
    console.log(
      pc.dim(
        `  Run ${pc.cyan('one relay event-types <platform>')} to see the full event list for a platform.\n`
      )
    );
  } catch (error) {
    spinner.stop('Failed to load relay platforms');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayEventTypesCommand(platform: string): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey, getApiBase());
  const spinner = output.createSpinner();
  spinner.start(`Loading event types for ${pc.cyan(platform)}...`);

  try {
    const eventTypes = await api.listRelayEventTypes(platform);

    if (output.isAgentMode()) {
      output.json({ platform, eventTypes });
      return;
    }

    spinner.stop(`${eventTypes.length} event type${eventTypes.length === 1 ? '' : 's'} found`);

    if (eventTypes.length === 0) {
      console.log(`\n  No event types found for ${platform}.\n`);
      return;
    }

    console.log();
    for (const type of eventTypes) {
      console.log(`  ${type}`);
    }
    console.log();
  } catch (error) {
    spinner.stop('Failed to load event types');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
