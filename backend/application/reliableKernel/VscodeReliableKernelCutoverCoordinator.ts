import {
  initializeCutoverRuntimeBinding,
  initializeEmptyRuntimeRoot
} from '../../reliableKernel/runtimeDatabase';
import {
  RootAuthority,
  RootAuthorityError
} from '../../reliableKernel/rootAuthority';
import type { RootBinding } from '../../reliableKernel/contracts';
import {
  legacyRuntimeRequiresCutover,
  performPhysicalCutover,
  readPhysicalCutoverRequest,
  recoverInterruptedPhysicalCutover
} from '../../reliableKernel/physicalCutover';
import { migratePreviousRuntimeEpochIfRequired } from '../../reliableKernel/runtimeEpochMigration';
import { migrateCurrentRuntimeManifestIfRequired } from '../../reliableKernel/runtimeManifestMigration';

export interface VscodeReliableKernelCutoverResult {
  binding: RootBinding;
  initialized: boolean;
  cutoverPerformed: boolean;
  epochMigrated?: boolean;
  manifestMigrated?: boolean;
  archiveDirectoryName?: string;
  migrationBackupDirectoryName?: string;
}

/**
 * Final-VSIX startup gate. A legacy file Runtime is never opened or imported: an explicit drained
 * request archives it with a durable journal, filters independent configuration, and only then
 * atomically activates the current SQLite/CAS RootBinding. Missing requests fail closed.
 */
export class VscodeReliableKernelCutoverCoordinator {
  public constructor(
    private readonly authority: RootAuthority,
    private readonly dataRootPath: string
  ) {}

  public async ensureCurrentRoot(): Promise<VscodeReliableKernelCutoverResult> {
    await recoverInterruptedPhysicalCutover(this.dataRootPath, this.authority);
    const request = await readPhysicalCutoverRequest(this.dataRootPath);
    if (request) {
      const result = await performPhysicalCutover(
        this.dataRootPath,
        this.authority,
        initializeCutoverRuntimeBinding
      );
      return {
        binding: result.binding,
        initialized: true,
        cutoverPerformed: true,
        ...(result.archiveDirectoryName ? { archiveDirectoryName: result.archiveDirectoryName } : {})
      };
    }

    const epochMigration = await migratePreviousRuntimeEpochIfRequired(this.authority);
    if (epochMigration) {
      return {
        binding: epochMigration.binding,
        initialized: epochMigration.migrated,
        cutoverPerformed: false,
        epochMigrated: epochMigration.migrated,
        ...(epochMigration.backupDirectoryName
          ? { migrationBackupDirectoryName: epochMigration.backupDirectoryName }
          : {})
      };
    }

    try {
      const binding = await this.authority.current();
      const manifestMigration = migrateCurrentRuntimeManifestIfRequired(binding);
      return {
        binding,
        initialized: false,
        cutoverPerformed: false,
        ...(manifestMigration.upgraded ? { manifestMigrated: true } : {})
      };
    } catch (error) {
      if (!(error instanceof RootAuthorityError) || error.code !== 'root-binding-missing') throw error;
    }

    if (await legacyRuntimeRequiresCutover(this.dataRootPath)) {
      throw new RootAuthorityError(
        'cutover-request-required',
        '检测到旧运行数据，但没有已完成drain的cutover request；为避免误动用户数据，拒绝启动。'
      );
    }

    try {
      return {
        binding: await initializeEmptyRuntimeRoot(this.authority),
        initialized: true,
        cutoverPerformed: false
      };
    } catch (error) {
      // Another activation can win the pointer race; only an already-complete current root is safe.
      if (error instanceof RootAuthorityError && error.code === 'root-binding-exists') {
        return {
          binding: await this.authority.current(),
          initialized: false,
          cutoverPerformed: false
        };
      }
      throw error;
    }
  }
}
