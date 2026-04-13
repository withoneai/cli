import open from 'open';

const ONE_APP_URL = 'https://app.withone.ai';

export function getConnectionUrl(platform: string): string {
  return `${ONE_APP_URL}/?#open=${platform}`;
}

export function getApiKeyUrl(): string {
  return `${ONE_APP_URL}/settings/api-keys`;
}

export async function openConnectionPage(platform: string): Promise<void> {
  const url = getConnectionUrl(platform);
  await open(url);
}

export async function openApiKeyPage(): Promise<void> {
  await open(getApiKeyUrl());
}

export function getCliAuthUrl(port: number, state: string): string {
  return `${ONE_APP_URL}/cli/auth?port=${port}&state=${encodeURIComponent(state)}`;
}

export async function openCliAuthPage(port: number, state: string): Promise<void> {
  const url = getCliAuthUrl(port, state);
  await open(url);
}
