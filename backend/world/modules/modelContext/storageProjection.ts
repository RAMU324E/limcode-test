import { defineStorageStateContributor } from '../../storageProjection/contributors';
import { modelContextStateProjectionReads, projectModelContextState } from './stateProjection';

export const modelContextStorageStateContributor = defineStorageStateContributor({
  key: 'modelContext',
  reads: modelContextStateProjectionReads,
  project: projectModelContextState
});
