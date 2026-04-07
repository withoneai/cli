import fs from 'node:fs';
import path from 'node:path';
import type { SyncProfile } from './types.js';

const PROFILES_DIR = path.join('.one', 'sync', 'profiles');

function profilePath(platform: string, model: string): string {
  return path.join(PROFILES_DIR, `${platform}_${model}.json`);
}

export function readProfile(platform: string, model: string): SyncProfile | null {
  const filePath = profilePath(platform, model);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as SyncProfile;
  } catch {
    return null;
  }
}

export function writeProfile(profile: SyncProfile): void {
  const required: (keyof SyncProfile)[] = ['platform', 'model', 'connectionKey', 'actionId', 'resultsPath', 'idField', 'pagination'];
  for (const field of required) {
    if (!profile[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
  if (!profile.pagination.type) {
    throw new Error('Missing required field: pagination.type');
  }

  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const filePath = profilePath(profile.platform, profile.model);
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
}

export function listProfiles(platform?: string): SyncProfile[] {
  if (!fs.existsSync(PROFILES_DIR)) return [];

  const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
  const profiles: SyncProfile[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(PROFILES_DIR, file), 'utf-8');
      const profile = JSON.parse(raw) as SyncProfile;
      if (!platform || profile.platform === platform) {
        profiles.push(profile);
      }
    } catch {
      // Skip corrupted profile files
    }
  }

  return profiles;
}

export function removeProfile(platform: string, model: string): boolean {
  const filePath = profilePath(platform, model);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function generateTemplate(platform: string, model: string, actionId?: string): Record<string, unknown> {
  return {
    platform,
    model,
    connectionKey: 'FILL_IN',
    actionId: actionId ?? 'FILL_IN',
    resultsPath: 'FILL_IN',
    idField: 'FILL_IN',
    pagination: {
      type: 'FILL_IN (cursor | token | offset | id | link | none)',
      nextPath: 'FILL_IN',
      passAs: 'FILL_IN',
    },
  };
}
