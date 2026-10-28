import open from 'open';
import { installContextToParams, type InstallContext } from './install-context.js';

const DEFAULT_APP_URL = 'https://app.withone.ai';

/**
 * The dashboard origin the CLI opens for browser flows. `ONE_APP_URL`
 * overrides it so the login and connect pages can be exercised against a
 * local frontend (`http://localhost:4202`). Resolved per call, never cached.
 */
export function oneAppUrl(): string {
  const override = process.env.ONE_APP_URL?.trim();
  return (override || DEFAULT_APP_URL).replace(/\/+$/, '');
}

export interface ConnectionUrlParams {
  orgId?: string;
  projectId?: string;
  env?: 'live' | 'test';
}

export function getConnectionUrl(platform: string, params?: ConnectionUrlParams): string {
  const searchParams = new URLSearchParams();
  if (params?.orgId) searchParams.set('orgId', params.orgId);
  if (params?.projectId) searchParams.set('projectId', params.projectId);
  if (params?.env) searchParams.set('env', params.env);

  const qs = searchParams.toString();
  return `${oneAppUrl()}/${qs ? `?${qs}` : ''}#open=${platform}`;
}

export function getApiKeyUrl(): string {
  return `${oneAppUrl()}/settings/api-keys`;
}

/** The space and env file every setup-page link names. */
export interface ConnectSetupScope {
  orgId?: string;
  projectId?: string;
  envFile?: string;
}

function connectSetupParams(scope: ConnectSetupScope, extra: [string, string | undefined][]): string {
  const params = new URLSearchParams();
  if (scope.orgId) params.set('orgId', scope.orgId);
  if (scope.projectId) params.set('projectId', scope.projectId);
  if (scope.envFile) params.set('env', scope.envFile);
  for (const [key, value] of extra) if (value) params.set(key, value);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * The browser half of `one connect create`, beside `one login`'s
 * `/cli/auth`. The person reviews the app (new, or the changes to an
 * existing one) and approves it with their dashboard session; a new app's
 * secrets are made and shown there once. The org and project pin the space
 * whatever the dashboard has selected, `env` names the file to paste into,
 * `port` and `state` are where the page reports back, and the config rides
 * in the fragment so no server ever logs it.
 */
export function getConnectSetupUrl(
  opts: ConnectSetupScope & {
    clientId?: string;
    permissionSetId?: string;
    port: number;
    state: string;
    handoff: string;
  }
): string {
  const target = opts.clientId ? encodeURIComponent(opts.clientId) : 'new';
  const qs = connectSetupParams(opts, [
    ['set', opts.permissionSetId],
    ['port', String(opts.port)],
    ['state', opts.state],
  ]);
  return `${oneAppUrl()}/cli/connect/${target}${qs}#c=${opts.handoff}`;
}

/** Where the CLI sends the browser once it has written `.env`: the setup
 *  page's summary for that app. */
export function getConnectDoneUrl(
  clientId: string,
  outcome: 'created' | 'updated' | 'unchanged',
  scope: ConnectSetupScope
): string {
  return `${oneAppUrl()}/cli/connect/${encodeURIComponent(clientId)}${connectSetupParams(scope, [['outcome', outcome]])}`;
}

export async function openConnectionPage(platform: string, params?: ConnectionUrlParams): Promise<void> {
  await open(getConnectionUrl(platform, params));
}

export async function openApiKeyPage(): Promise<void> {
  await open(getApiKeyUrl());
}

/**
 * The browser consent page for `one login`. `port` + `state` drive the
 * localhost callback; the install context (when given) becomes tags on the
 * key the page mints. Order is fixed so the printed URL reads the same way
 * every time.
 */
export function getCliAuthUrl(port: number, state: string, context?: InstallContext): string {
  const params = new URLSearchParams([
    ['port', String(port)],
    ['state', state],
    ...(context ? installContextToParams(context) : []),
  ]);
  return `${oneAppUrl()}/cli/auth?${params.toString()}`;
}
