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
