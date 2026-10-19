import { pathToFileURL } from 'node:url';
import type { WorkEnvironmentRecord } from '../../shared/protocol';
import { WORK_ENVIRONMENT_CAPABILITY } from '../../shared/workEnvironmentCatalog';
import { systemTemporaryDirectory, SYSTEM_TEMPORARY_WORK_ENVIRONMENT_ID } from '../capabilities/filesystem/systemTemporaryDirectory';

export { systemTemporaryDirectory, SYSTEM_TEMPORARY_WORK_ENVIRONMENT_ID } from '../capabilities/filesystem/systemTemporaryDirectory';
/** Ephemeral local boundary; it is never persisted as a user WorkEnvironment record. */
export function systemTemporaryWorkEnvironment(): WorkEnvironmentRecord {
  const rootPath = systemTemporaryDirectory();
  return {
    id: SYSTEM_TEMPORARY_WORK_ENVIRONMENT_ID,
    kind: 'localFolder',
    source: 'system',
    name: '系统临时目录',
    uri: pathToFileURL(rootPath).toString(),
    rootPath,
    displayPath: rootPath,
    description: '当前扩展宿主所在操作系统提供的临时目录。',
    capabilities: [
      WORK_ENVIRONMENT_CAPABILITY.LocalFileRead,
      WORK_ENVIRONMENT_CAPABILITY.LocalCommand,
      WORK_ENVIRONMENT_CAPABILITY.FileTransferRead,
      WORK_ENVIRONMENT_CAPABILITY.FileTransferWrite
    ],
    available: true,
    createdAt: 0,
    updatedAt: 0
  };
}
