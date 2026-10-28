import fs from 'node:fs';
import path from 'node:path';
import open from 'open';
import pc from 'picocolors';
import { ApiError, OneApi } from '../lib/api.js';
import { getConnectCredentialsUrl } from '../lib/browser.js';
import { ensureWhoAmI, getApiBase, getApiKey } from '../lib/config.js';
import {
  TYPES_FILE,
  actionNames,
  clientFields,
  connectorRule,
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

const ASK_NAME = 'Default permission set';

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

  const spinner = output.createSpinner();
  spinner.start(`Reading ${path.basename(file)}...`);

  try {
    const rules = await buildRules(api, config);
    const fields = clientFields(config);
    const existingId = readEnvValue(envText, 'ONE_CLIENT_ID');

    let app;
    let created = false;
    if (existingId) {
      try {
        app = await api.updateConnectApp(existingId, fields);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
    if (!app) {
      app = await api.createConnectApp(fields);
      created = true;
    }

    let permissionSetId = created ? undefined : readEnvValue(envText, 'ONE_PERMISSION_SET') || undefined;
    if (rules.length > 0) {
      const body = { name: ASK_NAME, connectorRules: rules };
      const set = permissionSetId
        ? await api.updatePermissionSet(app.clientId, permissionSetId, body)
        : await api.createPermissionSet(app.clientId, body);
      permissionSetId = set.id;
    }

    fs.writeFileSync(
      envFile,
      upsertEnv(envText, {
        ONE_CLIENT_ID: app.clientId,
        ONE_REDIRECT_URI: config.redirectUris[0],
        ...(permissionSetId ? { ONE_PERMISSION_SET: permissionSetId } : {}),
        ONE_CLIENT_SECRET: null,
        ONE_CONNECT_KEY: null,
      })
    );

    const whoami = await ensureWhoAmI(api);
    const credentialsUrl = getConnectCredentialsUrl(app.clientId, {
      orgId: whoami?.organization?.id,
      projectId: whoami?.project?.id,
      envFile: path.basename(envFile),
    });
    const secretsPending = !readEnvValue(envText, 'ONE_CLIENT_SECRET') || !readEnvValue(envText, 'ONE_CONNECT_KEY');
    const opening = options.open !== false && (created || secretsPending);
    if (opening) await open(credentialsUrl).catch(() => undefined);

    const result = {
      created,
      clientId: app.clientId,
      permissionSetId: permissionSetId ?? null,
      redirectUris: config.redirectUris,
      envFile: path.relative(cwd, envFile) || envFile,
      credentialsUrl,
      pending: secretsPending ? ['ONE_CLIENT_SECRET', 'ONE_CONNECT_KEY'] : [],
    };

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop(created ? `Created ${config.name}` : `Updated ${config.name}`);
    console.log();
    console.log(`  ${pc.dim('Client ID:')}       ${app.clientId}`);
    if (permissionSetId) console.log(`  ${pc.dim('Permission set:')}  ${permissionSetId}`);
    console.log(`  ${pc.dim('Wrote')}            ${result.envFile}`);
    console.log();
    if (secretsPending) {
      console.log(`  ${opening ? 'Opening your browser for the two secrets:' : 'Get the two secrets here:'}`);
      console.log(`  ${pc.underline(credentialsUrl)}`);
      console.log(`  ${pc.dim('Paste ONE_CLIENT_SECRET and ONE_CONNECT_KEY into')} ${result.envFile}${pc.dim('. They are never printed here.')}`);
      console.log();
    }
  } catch (error) {
    spinner.stop('Failed');
    output.error(`Error: ${message(error)}`);
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
