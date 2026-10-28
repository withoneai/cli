import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import open from 'open';
import pc from 'picocolors';
import { OneApi } from '../lib/api.js';
import { getConnectDoneUrl, getConnectSetupUrl } from '../lib/browser.js';
import { startConnectCallbackServer } from '../lib/connect-callback.js';
import { ensureWhoAmI, getApiBase, getApiKey } from '../lib/config.js';
import {
  TYPES_FILE,
  actionNames,
  buildHandoff,
  connectorRule,
  encodeHandoff,
  defaultEnvFile,
  findConfigFile,
  loadConfigFile,
  readEnvValue,
  renderTypes,
  resolveActions,
  upsertEnv,
  validateConfig,
  type ConnectAppConfig,
  type ConnectorRule,
} from '../lib/connect-app.js';
import * as output from '../lib/output.js';

/** As long as the person may need to read and approve the page. */
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

function requireApi(): OneApi {
  const apiKey = getApiKey();
  if (!apiKey) output.error('Not configured. Run `one init` first.');
  return new OneApi(apiKey, getApiBase());
}

async function readConfig(cwd: string, explicit?: string): Promise<{ file: string; config: ConnectAppConfig }> {
  const file = findConfigFile(cwd, explicit);
  if (!file) {
    output.error(
      explicit
        ? `No config at ${explicit}.`
        : 'No one.connect.ts here. Create one with defineConnectApp from @withone/connect/config.'
    );
  }
  let loaded: unknown;
  try {
    loaded = await loadConfigFile(file);
  } catch (error) {
    output.error(`Couldn't load ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const checked = validateConfig(loaded);
  if ('errors' in checked) output.error(`${path.basename(file)} has problems:\n  ${checked.errors.join('\n  ')}`);
  return { file, config: checked.config };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The ask as connector rules: slugs to catalog ids, action names to ids. */
async function buildRules(api: OneApi, config: ConnectAppConfig): Promise<ConnectorRule[]> {
  const asked = Object.entries(config.ask ?? {});
  if (asked.length === 0) return [];

  const platforms = await api.listPlatforms();
  const idBySlug = new Map(platforms.map((p) => [p.platform, p.id]));
  const unknownTools = asked.map(([slug]) => slug).filter((slug) => !idBySlug.has(slug));
  if (unknownTools.length > 0) {
    output.error(`Not in One's catalog: ${unknownTools.join(', ')}. Run \`one platforms\` for the slugs.`);
  }

  const rules: ConnectorRule[] = [];
  for (const [slug, ask] of asked) {
    const definitionId = idBySlug.get(slug)!;
    if (ask.access !== 'custom') {
      rules.push(connectorRule(definitionId, ask));
      continue;
    }
    const actions = await api.listAllAvailableActions(slug);
    const resolved = resolveActions(ask.actions, actionNames(actions), new Set(actions.map((a) => a.systemId)));
    if ('unknown' in resolved) {
      output.error(
        `${slug} has no action named ${resolved.unknown.join(', ')}. ` +
          `Run \`one connect types\` for the names, or \`one actions search ${slug} "<query>"\` for an id.`
      );
    }
    rules.push(connectorRule(definitionId, ask, resolved.ids));
  }
  return rules;
}

export async function connectCreateCommand(options: { config?: string; envFile?: string; open?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const api = requireApi();
  const { file, config } = await readConfig(cwd, options.config);
  const envFile = options.envFile ? path.resolve(cwd, options.envFile) : defaultEnvFile(cwd);
  const envText = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const existingId = readEnvValue(envText, 'ONE_CLIENT_ID') || undefined;

  const spinner = output.createSpinner();
  spinner.start(`Reading ${path.basename(file)}...`);

  let server: http.Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const rules = await buildRules(api, config);
    const whoami = await ensureWhoAmI(api);
    const scope = {
      orgId: whoami?.organization?.id,
      projectId: whoami?.project?.id,
      envFile: path.basename(envFile),
    };

    const state = crypto.randomBytes(16).toString('hex');
    const started = await startConnectCallbackServer(state, (done) =>
      getConnectDoneUrl(done.clientId, done.outcome, scope)
    );
    server = started.server;
    const url = getConnectSetupUrl({
      ...scope,
      clientId: existingId,
      permissionSetId: readEnvValue(envText, 'ONE_PERMISSION_SET') || undefined,
      port: started.port,
      state,
      handoff: encodeHandoff(buildHandoff(config, rules)),
    });

    const opening = options.open !== false;
    if (opening) await open(url).catch(() => undefined);
    const verb = existingId ? 'Approve the update' : 'Create the app';
    if (output.isAgentMode()) {
      // The JSON result comes only once the person approves; the link goes
      // out now so an agent can hand it over if no browser opened.
      process.stderr.write(`${verb} in the browser: ${url}\n`);
    } else {
      spinner.stop(`${verb} in your browser`);
      console.log(`  ${pc.underline(url)}`);
      console.log();
      spinner.start('Waiting for you to approve it...');
    }

    const outcome = await Promise.race([
      started.result,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SETUP_TIMEOUT_MS);
      }),
    ]);
    if (!outcome) output.error('Timed out waiting for the browser. Run `one connect create` again.');
    if (outcome.kind === 'cancelled') output.error('Cancelled in the browser. Nothing was changed.');
    if (outcome.kind === 'failed') output.error(`The setup page reported: ${outcome.reason}`);

    const created = outcome.outcome === 'created';
    fs.writeFileSync(
      envFile,
      upsertEnv(envText, {
        ONE_CLIENT_ID: outcome.clientId,
        ONE_REDIRECT_URI: config.redirectUris[0],
        ...(outcome.permissionSetId ? { ONE_PERMISSION_SET: outcome.permissionSetId } : {}),
        ...(created ? { ONE_CLIENT_SECRET: null, ONE_CONNECT_KEY: null } : {}),
      })
    );

    const result = {
      outcome: outcome.outcome,
      clientId: outcome.clientId,
      permissionSetId: outcome.permissionSetId,
      redirectUris: config.redirectUris,
      envFile: path.relative(cwd, envFile) || envFile,
    };
    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop(
      created ? `Created ${config.name}` : outcome.outcome === 'updated' ? `Updated ${config.name}` : `${config.name} is up to date`
    );
    console.log();
    console.log(`  ${pc.dim('Client ID:')}       ${outcome.clientId}`);
    if (outcome.permissionSetId) console.log(`  ${pc.dim('Permission set:')}  ${outcome.permissionSetId}`);
    console.log(`  ${pc.dim('Wrote')}            ${result.envFile}`);
    if (created) {
      console.log(`  ${pc.dim('The two secrets came from the browser page, never through here.')}`);
    }
    console.log();
  } catch (error) {
    spinner.stop('Failed');
    output.error(`Error: ${message(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
    server?.close();
  }
}

export async function connectTypesCommand(options: { config?: string }): Promise<void> {
  const cwd = process.cwd();
  const api = requireApi();
  const spinner = output.createSpinner();
  spinner.start("Reading One's catalog...");

  try {
    const file = findConfigFile(cwd, options.config);
    const config = file ? validateConfig(await loadConfigFile(file)) : null;
    const tools = Object.keys(config && 'config' in config ? config.config.ask ?? {} : {});

    const platforms = await api.listPlatforms();
    const known = new Set(platforms.map((p) => p.platform));
    const actionsByTool: Record<string, string[]> = {};
    for (const tool of tools.filter((t) => known.has(t))) {
      actionsByTool[tool] = [...actionNames(await api.listAllAvailableActions(tool)).keys()];
    }

    const target = path.join(file ? path.dirname(file) : cwd, TYPES_FILE);
    fs.writeFileSync(target, renderTypes([...known], actionsByTool));

    if (output.isAgentMode()) {
      output.json({ file: target, tools: known.size, actions: actionsByTool });
      return;
    }
    spinner.stop(`Wrote ${path.relative(cwd, target) || target}`);
    console.log(`  ${pc.dim(`${known.size} tools; action names for ${Object.keys(actionsByTool).join(', ') || 'none yet (add tools to ask, then run it again)'}`)}`);
  } catch (error) {
    spinner.stop('Failed');
    output.error(`Error: ${message(error)}`);
  }
}
