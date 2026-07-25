import type { WorldPlugin } from '../../plugin';
import { ClientStateContributorsKey } from '../../clientSync/resources';
import { backgroundProcessClientSyncContributor } from './clientSync';
import { BackgroundProcessSnapshotKey, EMPTY_BACKGROUND_PROCESS_SNAPSHOT } from './resources';

export function backgroundProcessPlugin(): WorldPlugin {
  return {
    name: 'backgroundProcess',
    install(ctx) {
      ctx.world.setResource(BackgroundProcessSnapshotKey, EMPTY_BACKGROUND_PROCESS_SNAPSHOT);
      ctx.world.getResource(ClientStateContributorsKey).register(backgroundProcessClientSyncContributor);
    }
  };
}
