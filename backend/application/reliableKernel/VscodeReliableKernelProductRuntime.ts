import * as vscode from 'vscode';
import { EXTENSION_PACKAGE_NAME, EXTENSION_VERSION } from '../../../shared/extensionIdentity';
import { createGlobalSettingsRecord, resolveDataRootUri } from '../../capabilities/vscodeStorage/globalStatus';
import {
  createVscodeStoragePaths,
  type StoragePaths
} from '../../capabilities/vscodeStorage/paths';
import type {
  ReliableAgentLifecycleObserver,
  ReliableAgentTransientObserver
} from '../../reliableKernel/agentLoop';
import { ReliableChildAgentCoordinator } from '../../reliableKernel/childAgentCoordinator';
import { ReliableDiagnosticJournal } from '../../reliableKernel/diagnosticJournal';
import { FrozenAuthorityMcpPolicyGate } from '../../reliableKernel/frozenMcpPolicyGate';
import { ReliableLlmProviderRegistry } from '../../reliableKernel/llmCapabilityProviderRegistry';
import {
  ReliableKernelApplication,
  type ReliableKernelRecoveryReport
} from '../../reliableKernel/runtimeApplication';
import { RootAuthority } from '../../reliableKernel/rootAuthority';
import { ReliableToolDispatcher } from '../../reliableKernel/toolDispatcher';
import { createVscodeRootAuthority } from '../../reliableKernel/vscodeRootAuthority';
import { VscodeConfigurationAuthority } from '../../reliableKernel/vscodeConfigurationAuthority';
import {
  VscodeReliableToolHost,
  type VscodeReliableToolHostOptions
} from './VscodeReliableToolHost';
import { VscodeReliableFileDiffEditor } from './VscodeReliableFileDiffEditor';
import { getRuntimeBuildInfo } from '../runtimeBuildInfo';
import { ReliableConversationRunner } from './ReliableConversationRunner';

export interface VscodeReliableKernelProductRuntimeOptions {
  /** Tests/candidate validation may supply an isolated authority. Production resolves it through getPaths(). */
  authority?: RootAuthority;
  transientObserver?: ReliableAgentTransientObserver;
  lifecycleObserver?: ReliableAgentLifecycleObserver;
  dispatchSpecial?: VscodeReliableToolHostOptions['dispatchSpecial'];
}

/**
 * VS Code product composition for the reliable kernel.
 *
 * This class opens only an already activated fenced Runtime root. It never initializes, imports,
 * migrates or falls back to legacy Runtime data. Configuration remains in its independent settings
 * roots and is re-resolved through getPaths() for every authority operation.
 */
export class VscodeReliableKernelProductRuntime {
  public readonly application: ReliableKernelApplication;
  public readonly configuration: VscodeConfigurationAuthority;
  public readonly toolHost: VscodeReliableToolHost;
  public readonly recovery: ReliableKernelRecoveryReport;
  public readonly childAgents: ReliableChildAgentCoordinator;
  public readonly fileDiffs: VscodeReliableFileDiffEditor;
  public readonly conversations: ReliableConversationRunner;
  public readonly providerRegistry: ReliableLlmProviderRegistry;
  public readonly diagnostics: ReliableDiagnosticJournal;

  private constructor(input: {
    application: ReliableKernelApplication;
    configuration: VscodeConfigurationAuthority;
    toolHost: VscodeReliableToolHost;
    recovery: ReliableKernelRecoveryReport;
    childAgents: ReliableChildAgentCoordinator;
    fileDiffs: VscodeReliableFileDiffEditor;
    conversations: ReliableConversationRunner;
    providerRegistry: ReliableLlmProviderRegistry;
    diagnostics: ReliableDiagnosticJournal;
  }) {
    this.application = input.application;
    this.configuration = input.configuration;
    this.toolHost = input.toolHost;
    this.recovery = input.recovery;
    this.childAgents = input.childAgents;
    this.fileDiffs = input.fileDiffs;
    this.conversations = input.conversations;
    this.providerRegistry = input.providerRegistry;
    this.diagnostics = input.diagnostics;
  }

  public static async open(
    context: vscode.ExtensionContext,
    options: VscodeReliableKernelProductRuntimeOptions = {}
  ): Promise<VscodeReliableKernelProductRuntime> {
    const getPaths = (): StoragePaths => createVscodeStoragePaths(resolveDataRootUri(context));
    const configuration = new VscodeConfigurationAuthority(getPaths, context);
    await configuration.synchronizeWorkspaceFolders((vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
      uri: folder.uri.toString(),
      name: folder.name,
      rootPath: folder.uri.fsPath,
      index
    })));
    const authority = options.authority ?? createVscodeRootAuthority(getPaths);
    const diagnostics = new ReliableDiagnosticJournal(authority, await authority.current());
    let application: ReliableKernelApplication | undefined;
    let childAgents: ReliableChildAgentCoordinator | undefined;
    let fileDiffs: VscodeReliableFileDiffEditor | undefined;
    let conversations: ReliableConversationRunner | undefined;
    const toolHost = new VscodeReliableToolHost(context, configuration, {
      dispatchSpecial: async (definition, input, frozenAuthority) => {
        const childResult = await childAgents?.dispatch(input);
        if (childResult) return childResult;
        return options.dispatchSpecial?.(definition, input, frozenAuthority);
      }
    });
    const providers = new ReliableLlmProviderRegistry({
      loadProviderConfig: (providerConfigId) => configuration.providerConfig(providerConfigId),
      proxy: () => createGlobalSettingsRecord(context).proxy || undefined,
      headers: { 'User-Agent': `${EXTENSION_PACKAGE_NAME}/${EXTENSION_VERSION}` },
      resolveAttachment: async (input) => {
        if (!input.attachmentId) {
          throw new Error('可靠 Provider 只接受已进入 Runtime CAS 的 attachmentId。');
        }
        if (!application) throw new Error('可靠 Runtime 尚未完成组合，无法解析附件。');
        return application.attachments.resolveInlineData(input.attachmentId);
      }
    });
    const observedFirstTransient = new Set<string>();
    const transientObserver: ReliableAgentTransientObserver = {
      observe(event) {
        application?.webviewFeed.broadcastTransient(event);
        if (!observedFirstTransient.has(event.modelRequestId)) {
          observedFirstTransient.add(event.modelRequestId);
          while (observedFirstTransient.size > 2_048) {
            const oldest = observedFirstTransient.values().next().value as string | undefined;
            if (!oldest) break;
            observedFirstTransient.delete(oldest);
          }
          diagnostics.observe({
            eventKind: 'provider.transient.first_event',
            scopeKind: 'model_request',
            scopeId: event.modelRequestId,
            correlationId: String(event.event.streamSeq),
            observedAt: event.observedAt,
            metadata: {
              conversationId: event.conversationId,
              turnId: event.turnId,
              modelRequestId: event.modelRequestId,
              streamSeq: String(event.event.streamSeq),
              kind: event.event.kind
            }
          });
        }
        options.transientObserver?.observe(event);
      }
    };
    const lifecycleObserver: ReliableAgentLifecycleObserver = {
      observe(event) {
        diagnostics.observe({
          eventKind: 'agent.lifecycle',
          scopeKind: 'turn',
          scopeId: event.turnId,
          correlationId: event.modelRequestId ?? event.toolCallId,
          observedAt: event.observedAt,
          metadata: {
            turnId: event.turnId,
            stage: event.stage,
            ...(event.round !== undefined ? { round: event.round } : {}),
            ...(event.modelRequestId ? { modelRequestId: event.modelRequestId } : {}),
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
            ...(event.errorName ? { errorName: event.errorName } : {})
          }
        });
        options.lifecycleObserver?.observe(event);
      }
    };
    try {
      await toolHost.initialize();
      application = await ReliableKernelApplication.open(authority, {
        authorityCompiler: configuration,
        resolveWorkEnvironment: async (workEnvironmentId) => {
          const environment = await configuration.workEnvironment(workEnvironmentId);
          if (!environment.available || environment.kind !== 'localFolder' || !environment.rootPath) return undefined;
          return { id: environment.id, rootPath: environment.rootPath };
        },
        mcpConnections: toolHost.mcp,
        createMcpPolicyGate: ({ database, contentStore }) =>
          new FrozenAuthorityMcpPolicyGate(database, contentStore),
        attachmentSettings: configuration,
        providers,
        createToolDispatcher: ({
          database,
          contentStore,
          runtime,
          files,
          fileMutations,
          processes,
          mcp,
          interactions
        }) => new ReliableToolDispatcher({
          database,
          contentStore,
          effects: runtime.effects,
          files,
          fileMutations,
          processes,
          mcp,
          interactions,
          host: toolHost
        }),
        transientObserver,
        lifecycleObserver,
        diagnosticObserver: diagnostics,
        runtimeBuildInfo: getRuntimeBuildInfo
      });
      fileDiffs = new VscodeReliableFileDiffEditor(application.files, diagnostics);
      conversations = new ReliableConversationRunner(
        application,
        `vscode-product:${application.database.hostBootId}`
      );
      childAgents = new ReliableChildAgentCoordinator({
        database: application.database,
        effects: application.runtime.effects,
        children: application.runtime.children,
        answers: application.runtime.answers,
        deliveries: application.runtime.deliveries,
        modelProvider: application.modelProvider,
        agentLoop: application.agentLoop,
        agents: { resolve: (input) => configuration.resolveAgent(input) }
      });
      const recovery = await application.recover();
      return new VscodeReliableKernelProductRuntime({
        application,
        configuration,
        toolHost,
        recovery,
        childAgents,
        fileDiffs,
        conversations,
        providerRegistry: providers,
        diagnostics
      });
    } catch (error) {
      if (application) {
        fileDiffs?.dispose();
        conversations?.dispose();
        await application.modelProvider.abortAllActiveDispatches().catch(() => undefined);
        await conversations?.waitForIdle().catch(() => undefined);
        // Child tasks need the live SQLite/CAS composition while they abort and settle.
        await childAgents?.dispose().catch(() => undefined);
        await application.close().catch(() => undefined);
      } else {
        await toolHost.dispose().catch(() => undefined);
        providers.dispose();
      }
      await diagnostics.close().catch(() => undefined);
      throw error;
    }
  }

  public async close(): Promise<void> {
    try {
      this.fileDiffs.dispose();
      this.conversations.dispose();
      await this.application.modelProvider.abortAllActiveDispatches();
      await this.conversations.waitForIdle();
      // Never close the database underneath in-flight child Turn finalization.
      await this.childAgents.dispose();
      await this.application.close();
    } finally {
      await this.diagnostics.close();
    }
  }
}
