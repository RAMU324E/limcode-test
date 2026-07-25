import { defineResource } from '../../../ecs/types';
import type { BackgroundProcessSnapshot } from '../../../capabilities/backgroundProcessTypes';

export const BackgroundProcessSnapshotKey = defineResource<BackgroundProcessSnapshot>('BackgroundProcessSnapshot');

export const EMPTY_BACKGROUND_PROCESS_SNAPSHOT: BackgroundProcessSnapshot = {
  processes: [],
  originLinks: []
};
