import {
  ReliableAgentLoop,
  type ReliableAgentLifecycleObserver,
  type ReliableAgentProviderRegistry,
  type ReliableAgentToolDispatcher,
  type ReliableAgentTransientObserver
} from './agentLoop';
import {
  AttachmentIngestService,
  type AttachmentSettingsAuthority
} from './attachmentIngest';
import {
  createReliableKernelRuntimeServices,
  type ReliableKernelRuntimeServices
} from './runtimeServices';
import { ContentAddressedStore } from './contentAddressedStore';
import { ContextCompressionControlPlane } from './contextCompression';
import { ContextSequenceControlPlane } from './contextSequence';
import type { RuntimeBuildInfoRecord } from '../../shared/protocol';
import type { ReliableDiagnosticObserver } from './diagnosticJournal';
import {
  FileChangeControlPlane,
  FileMutationDispatcher,
  type WorkEnvironmentBoundaryResolver
} from './fileEffects';
import {
  McpEffectDispatcher,
  type McpExistingPolicyGate,
  type McpMemoryConnectionRegistry
} from './mcpEffects';
import { ModelProviderControlPlane } from './modelProviderControlPlane';
import { PhaseDRecoveryScanner, type PhaseDRecoveryResult } from './phaseDRecovery';
import { type PhaseFRecoveryResult } from './phaseFRecovery';
import { ProcessControlPlane } from './processEffects';
import { RootAuthority } from './rootAuthority';
import { RuntimeDatabase } from './runtimeDatabase';
import { ToolInteractionControlPlane } from './toolInteractions';
import {
  TurnControlPlane,
  type TurnAuthorityCompiler
} from './turnControlPlane';
import { TurnOutputControlPlane } from './turnOutput';
import { ReliableKernelWebviewFeedBridge } from './webviewFeedBridge';

export interface ReliableKernelToolDispatcherContext {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  runtime: ReliableKernelRuntimeServices;
  files: FileChangeControlPlane;
  fileMutations: FileMutationDispatcher;
  processes: ProcessControlPlane;
  mcp: McpEffectDispatcher;
  interactions: ToolInteractionControlPlane;
  attachments: AttachmentIngestService;
  turns: TurnControlPlane;
  turnOutput: TurnOutputControlPlane;
}

function missingToolDispatcher(): never {
  throw new TypeError('ReliableKernelApplication requires toolDispatcher or createToolDispatcher.');
}

function missingMcpPolicyGate(): never {
  throw new TypeError('ReliableKernelApplication requires mcpPolicyGate or createMcpPolicyGate.');
}

export interface ReliableKernelApplicationDependencies {
  authorityCompiler: TurnAuthorityCompiler;
  resolveWorkEnvironment: WorkEnvironmentBoundaryResolver;
  mcpConnections: McpMemoryConnectionRegistry;
  mcpPolicyGate?: McpExistingPolicyGate;
  createMcpPolicyGate?: (context: {
    database: RuntimeDatabase;
    contentStore: ContentAddressedStore;
  }) => McpExistingPolicyGate;
  attachmentSettings: AttachmentSettingsAuthority;
  providers: ReliableAgentProviderRegistry;
  toolDispatcher?: ReliableAgentToolDispatcher;
  createToolDispatcher?: (context: ReliableKernelToolDispatcherContext) => ReliableAgentToolDispatcher;
  transientObserver?: ReliableAgentTransientObserver;
  lifecycleObserver?: ReliableAgentLifecycleObserver;
  diagnosticObserver?: ReliableDiagnosticObserver;
  runtimeBuildInfo?: () => RuntimeBuildInfoRecord;
  now?: () => string;
}

export interface ReliableKernelRecoveryReport {
  phaseD: PhaseDRecoveryResult[];
  phaseF: PhaseFRecoveryResult[];
}

/**
 * 可靠运行内核的唯一组合根。
 *
 * 该对象只接收配置 authority 和外部 capability adapter，不读取旧文件 Runtime，也不拥有
 * VS Code/Webview 展示规则。SQLite worker 是唯一 Runtime writer；所有长期服务共享同一个
 * fenced RootBinding、RuntimeDatabase 和 CAS。
 */
export class ReliableKernelApplication {
  public readonly database: RuntimeDatabase;
  public readonly contentStore: ContentAddressedStore;
  public readonly runtime: ReliableKernelRuntimeServices;
  public readonly context: ContextSequenceControlPlane;
  public readonly compression: ContextCompressionControlPlane;
  public readonly modelProvider: ModelProviderControlPlane;
  public readonly files: FileChangeControlPlane;
  public readonly fileMutations: FileMutationDispatcher;
  public readonly processes: ProcessControlPlane;
  public readonly mcp: McpEffectDispatcher;
  public readonly interactions: ToolInteractionControlPlane;
  public readonly attachments: AttachmentIngestService;
  public readonly turns: TurnControlPlane;
  public readonly turnOutput: TurnOutputControlPlane;
  public readonly toolDispatcher: ReliableAgentToolDispatcher;
  public readonly agentLoop: ReliableAgentLoop;
  public readonly phaseDRecovery: PhaseDRecoveryScanner;
  public readonly webviewFeed: ReliableKernelWebviewFeedBridge;

  private closePromise: Promise<void> | undefined;
  private readonly providers: ReliableAgentProviderRegistry;
  private readonly diagnosticObserver: ReliableDiagnosticObserver | undefined;

  private constructor(
    private readonly authority: RootAuthority,
    database: RuntimeDatabase,
    contentStore: ContentAddressedStore,
    dependencies: ReliableKernelApplicationDependencies
  ) {
    this.providers = dependencies.providers;
    this.diagnosticObserver = dependencies.diagnosticObserver;
    this.database = database;
    this.contentStore = contentStore;

    const options = dependencies.now ? { now: dependencies.now } : {};
    this.runtime = createReliableKernelRuntimeServices(database, contentStore, {
      ...options,
      authorityCompiler: dependencies.authorityCompiler
    });
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
    this.compression = new ContextCompressionControlPlane(database, contentStore, options);
    this.modelProvider = new ModelProviderControlPlane(database, contentStore, options);
    this.files = new FileChangeControlPlane(database, contentStore, this.runtime.effects, options);
    this.fileMutations = new FileMutationDispatcher(
      database,
      contentStore,
      this.runtime.effects,
      dependencies.resolveWorkEnvironment
    );
    this.processes = new ProcessControlPlane(
      database,
      contentStore,
      this.runtime.effects,
      authority,
      database.binding,
      options
    );
    const mcpPolicyGate = dependencies.mcpPolicyGate
      ?? dependencies.createMcpPolicyGate?.({ database, contentStore })
      ?? missingMcpPolicyGate();
    this.mcp = new McpEffectDispatcher(
      database,
      this.runtime.effects,
      dependencies.mcpConnections,
      mcpPolicyGate
    );
    this.interactions = new ToolInteractionControlPlane(database, contentStore, this.runtime.effects, options);
    this.attachments = new AttachmentIngestService(
      database,
      contentStore,
      dependencies.attachmentSettings,
      options
    );
    this.turns = new TurnControlPlane(database, contentStore, {
      authorityCompiler: dependencies.authorityCompiler,
      unresolvedFileClosure: this.files,
      ...options
    });
    this.turnOutput = new TurnOutputControlPlane(database, contentStore, options);
    this.toolDispatcher = dependencies.toolDispatcher ?? dependencies.createToolDispatcher?.({
      database,
      contentStore,
      runtime: this.runtime,
      files: this.files,
      fileMutations: this.fileMutations,
      processes: this.processes,
      mcp: this.mcp,
      interactions: this.interactions,
      attachments: this.attachments,
      turns: this.turns,
      turnOutput: this.turnOutput
    }) ?? missingToolDispatcher();
    this.agentLoop = new ReliableAgentLoop(
      database,
      contentStore,
      this.turns,
      this.turnOutput,
      this.modelProvider,
      this.runtime.effects,
      dependencies.providers,
      this.toolDispatcher,
      dependencies.transientObserver,
      dependencies.lifecycleObserver,
      options
    );
    this.phaseDRecovery = new PhaseDRecoveryScanner(
      database,
      this.runtime.effects,
      this.files,
      this.processes,
      this.mcp,
      dependencies.resolveWorkEnvironment,
      this.turns
    );
    this.webviewFeed = new ReliableKernelWebviewFeedBridge(
      this.runtime.clientFeed,
      this.runtime.details,
      undefined,
      dependencies.diagnosticObserver,
      dependencies.runtimeBuildInfo
    );
  }

  /** Opens only an already activated current Runtime root. Missing/pending/stale roots fail closed. */
  public static async open(
    authority: RootAuthority,
    dependencies: ReliableKernelApplicationDependencies
  ): Promise<ReliableKernelApplication> {
    const database = await RuntimeDatabase.open(authority);
    try {
      const contentStore = new ContentAddressedStore(authority, database.binding);
      return new ReliableKernelApplication(authority, database, contentStore, dependencies);
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  public async validateBinding(): Promise<void> {
    await this.authority.validate(this.database.binding);
  }

  /** Runs only registered deterministic recovery scans; it never retries ambiguous external effects. */
  public async recover(): Promise<ReliableKernelRecoveryReport> {
    await this.validateBinding();
    const phaseD = await this.phaseDRecovery.runAll();
    const phaseF = await this.runtime.recovery.runAll();
    for (const result of phaseD) {
      this.diagnosticObserver?.observe({
        eventKind: 'recovery.scan.completed',
        scopeKind: 'runtime',
        correlationId: result.id,
        metadata: {
          kind: 'phase-d',
          status: 'completed',
          hostBootId: this.database.hostBootId,
          scanned: result.scanned,
          reconciled: result.reconciled,
          unknown: result.unknown
        }
      });
    }
    for (const result of phaseF) {
      this.diagnosticObserver?.observe({
        eventKind: 'recovery.scan.completed',
        scopeKind: 'runtime',
        correlationId: result.id,
        metadata: {
          kind: 'phase-f',
          status: 'completed',
          hostBootId: this.database.hostBootId,
          scanned: result.scanned,
          reconciled: result.reconciled,
          unchanged: result.unchanged
        }
      });
    }
    return { phaseD, phaseF };
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.webviewFeed.close();
      this.runtime.clientFeed.close();
      await this.modelProvider.abortAllActiveDispatches();
      await this.toolDispatcher.dispose?.();
      await this.providers.dispose?.();
      await this.database.close();
    })();
    return this.closePromise;
  }
}
