import { ClientStateContributorsKey } from '../../clientSync/resources';
import type { WorldPlugin } from '../../plugin';
import { StorageStateContributorsKey } from '../../storageProjection/resources';
import { modelContextClientSyncContributor } from './clientSync';
import { modelContextStorageStateContributor } from './storageProjection';

export function modelContextPlugin(): WorldPlugin {
  return {
    name: 'modelContext',
    install(ctx) {
      ctx.world.getResource(ClientStateContributorsKey).register(modelContextClientSyncContributor);
      ctx.world.getResource(StorageStateContributorsKey).register(modelContextStorageStateContributor);
    }
  };
}
