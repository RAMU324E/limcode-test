import type { WorldPlugin } from '../plugin';
import { committedConversationControlClientSyncContributor } from './committedConversationControlState';
import { ClientStateContributorRegistry } from './contributors';
import { emptyDirtyConversationState } from './dirtyConversations';
import { ClientStateContributorsKey, ClientStateDirtyConversationIdsKey, ClientSyncFastPatchStateKey, ClientSyncStateKey, CommittedConversationControlStatesKey, CommittedConversationHeadsKey } from './resources';

export function clientSyncPlugin(): WorldPlugin {
  return {
    name: 'clientSync',
    install(ctx) {
      const contributors = new ClientStateContributorRegistry();
      contributors.register(committedConversationControlClientSyncContributor);
      ctx.world.setResource(ClientStateContributorsKey, contributors);
      ctx.world.setResource(CommittedConversationControlStatesKey, { byConversationId: {} });
      ctx.world.setResource(ClientSyncStateKey, {
        lastState: null,
        projectionClock: '',
        contributorStates: {},
        dirtyConversationResourceVersion: 0,
        streams: {}
      });
      ctx.world.setResource(ClientSyncFastPatchStateKey, {
        patches: [],
        deferFullSync: false,
        requireFullSync: false
      });
      ctx.world.setResource(ClientStateDirtyConversationIdsKey, emptyDirtyConversationState());
      ctx.world.setResource(CommittedConversationHeadsKey, {});
    }
  };
}
