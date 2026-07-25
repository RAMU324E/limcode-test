import { defineClientStateContributor } from '../../clientSync/contributors';
import { modelContextStateProjectionReads, projectModelContextState } from './stateProjection';

export const projectModelContextClientState = projectModelContextState;

export const modelContextClientSyncContributor = defineClientStateContributor({
  key: 'modelContext',
  tables: [
    'modelContextProjections',
    'modelContextProjectionSourceLinks',
    'requestModelContextProjectionLinks',
    'compressionModelContextProjectionLinks'
  ],
  reads: modelContextStateProjectionReads,
  project: projectModelContextClientState,
  worker: {
    modulePath: '../world/modules/modelContext/clientSync',
    projectExport: 'projectModelContextClientState'
  }
});
