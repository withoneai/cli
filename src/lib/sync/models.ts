import type { OneApi } from '../api.js';
import type { DiscoveredModel } from './types.js';

interface RawAvailableAction {
  title: string;
  key: string;
  modelName: string;
  method: string;
  path: string;
}

/**
 * Parse an action key to extract action type.
 * Format: api::{platform}::{version}::{model}::{actionType}::{path}::{title}::{hash}
 */
function parseActionType(actionKey: string): string | null {
  const parts = actionKey.split('::');
  if (parts.length < 5) return null;
  return parts[4];
}

/**
 * Discover available data models for a platform by fetching all actions
 * and filtering to list/get_many operations.
 *
 * NOTE: The returned actionId uses the api:: format which is a discovery key.
 * To get the executable action ID (conn_mod_def:: format), use:
 *   one actions search <platform> "<title>" -t execute
 */
export async function discoverModels(api: OneApi, platform: string): Promise<DiscoveredModel[]> {
  const actions = await api.listAvailableActions(platform) as unknown as RawAvailableAction[];

  const listActionTypes = new Set(['get_many', 'list', 'get_all']);
  const modelMap = new Map<string, DiscoveredModel>();

  for (const action of actions) {
    const actionType = parseActionType(action.key);
    if (!actionType) continue;
    if (!listActionTypes.has(actionType)) continue;

    const modelName = action.modelName;
    if (!modelName) continue;

    // Prefer get_many over others
    if (modelMap.has(modelName)) {
      const existing = modelMap.get(modelName)!;
      const existingType = parseActionType(existing.listAction.actionId);
      if (existingType === 'get_many') continue;
    }

    modelMap.set(modelName, {
      name: modelName,
      displayName: action.title,
      listAction: {
        actionId: action.key,
        path: action.path,
        method: action.method,
      },
    });
  }

  return Array.from(modelMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
