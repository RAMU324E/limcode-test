import * as os from 'node:os';
import * as path from 'node:path';

export const SYSTEM_TEMPORARY_WORK_ENVIRONMENT_ID = 'limcode:system-temporary';

/** The extension host's platform-native temporary directory. */
export function systemTemporaryDirectory(): string {
  return path.resolve(os.tmpdir());
}
