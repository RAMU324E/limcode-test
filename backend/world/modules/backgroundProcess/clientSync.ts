import type { ClientState } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { defineClientStateContributor } from '../../clientSync/contributors';
import { BackgroundProcessSnapshotKey, EMPTY_BACKGROUND_PROCESS_SNAPSHOT } from './resources';

export const backgroundProcessStateProjectionReads: AccessDeclaration = {
  resources: [BackgroundProcessSnapshotKey]
};

export function projectBackgroundProcessClientState(world: WorldReader): Partial<ClientState> {
  const snapshot = world.tryGetResource(BackgroundProcessSnapshotKey) ?? EMPTY_BACKGROUND_PROCESS_SNAPSHOT;
  return {
    backgroundProcesses: snapshot.processes.map((record) => ({ ...record })),
    backgroundProcessOriginLinks: snapshot.originLinks.map((record) => ({ ...record }))
  };
}

export const backgroundProcessClientSyncContributor = defineClientStateContributor({
  key: 'backgroundProcess',
  tables: ['backgroundProcesses', 'backgroundProcessOriginLinks'],
  reads: backgroundProcessStateProjectionReads,
  project: projectBackgroundProcessClientState,
  worker: {
    modulePath: '../world/modules/backgroundProcess/clientSync',
    projectExport: 'projectBackgroundProcessClientState'
  }
});
