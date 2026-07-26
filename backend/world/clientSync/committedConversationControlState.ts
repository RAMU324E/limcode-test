import { clientStateWithTables } from '../../../shared/clientStateSchema';
import type { ClientState, ClientStateTableKey } from '../../../shared/protocol';
import type { World, WorldReader } from '../../ecs/types';
import { defineClientStateContributor } from './contributors';
import { CommittedConversationControlStatesKey } from './resources';

export const COMMITTED_CONVERSATION_CONTROL_TABLE_KEYS = [
  'turns',
  'turnIntents',
  'turnIntentRevisions',
  'pendingTurnInputs',
  'executionLeases',
  'authoritySnapshots',
  'interactionRequests',
  'interactionOwnerLinks',
  'interactionResponses',
  'runtimeDeliveryLinks'
] as const satisfies readonly ClientStateTableKey[];

export function installCommittedConversationControlState(
  world: World,
  conversationId: string,
  state: ClientState
): void {
  const current = world.tryGetResource(CommittedConversationControlStatesKey) ?? { byConversationId: {} };
  world.setResource(CommittedConversationControlStatesKey, {
    byConversationId: {
      ...current.byConversationId,
      [conversationId]: clientStateWithTables(state, COMMITTED_CONVERSATION_CONTROL_TABLE_KEYS)
    }
  });
}

export function removeCommittedConversationControlState(world: World, conversationId: string): void {
  const current = world.tryGetResource(CommittedConversationControlStatesKey);
  if (!current?.byConversationId[conversationId]) return;
  const byConversationId = { ...current.byConversationId };
  delete byConversationId[conversationId];
  world.setResource(CommittedConversationControlStatesKey, { byConversationId });
}

export function projectCommittedConversationControlClientState(world: WorldReader): Partial<ClientState> {
  const source = world.getResource(CommittedConversationControlStatesKey).byConversationId;
  const conversationIds = Object.keys(source).sort((left, right) => left.localeCompare(right));
  const result: Partial<ClientState> = {};
  const writable = result as unknown as Record<ClientStateTableKey, unknown>;
  for (const tableKey of COMMITTED_CONVERSATION_CONTROL_TABLE_KEYS) {
    const records: unknown[] = [];
    for (const conversationId of conversationIds) {
      records.push(...source[conversationId]![tableKey] as unknown[]);
    }
    writable[tableKey] = records;
  }
  return result;
}

export const committedConversationControlClientSyncContributor = defineClientStateContributor({
  key: 'committedConversationControl',
  tables: COMMITTED_CONVERSATION_CONTROL_TABLE_KEYS,
  reads: { resources: [CommittedConversationControlStatesKey] },
  project: projectCommittedConversationControlClientState,
  worker: {
    modulePath: '../world/clientSync/committedConversationControlState',
    projectExport: 'projectCommittedConversationControlClientState'
  }
});
