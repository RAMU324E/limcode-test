import type { StorageCapability, WebviewCapability } from '../capabilities/types';
import type {
  BridgeClientId,
  InteractionResolvePayload,
  MessageContent,
  ToolDecisionPayload,
  WebviewToExtensionMessage
} from '../../shared/protocol';
import { BridgeMessageType, createMessageId } from '../../shared/protocol';
import { CONVERSATION_ATTACHMENTS_RESOURCE_KEY } from '../../shared/conversationReliability';
import type { CommandAck, CommandEnvelope, CommittedConversationHead, EffectiveTurnAuthority, JsonValue, PlannedPatchBatch } from '../../shared/conversationReliability';
import { isStableId, requireStableId, type CommandId, type ConversationId, type InteractionRequestId, type RunId, type ToolCallId } from '../../shared/stableIds';
import {
  DurableCommandFailureError,
  FileConversationTransactionBackend,
  FileTransactionIntegrityError,
  PreparedTransitionPendingError,
  SourceClaimRecoveryRequiredError
} from './fileConversationTransactionBackend';
import { ANSWER_BRIDGE_RESOURCE_KEY, DurableScopeIncompleteError, RuntimeAuthorityAdapter } from './runtimeAuthorityStore';
import { RunGraphClosureIntegrityError } from './runGraphClosureResolver';
import { RuntimeStableIdFactory, stableIdFromSeed } from './stableIdFactory';
import {
  DeleteConversationAggregateCommandHandler,
  DeleteConversationCommandHandler,
  EditConversationCommandHandler,
  RenameConversationCommandHandler,
  RetryConversationCommandHandler
} from './domain/handlers';
import {
  EnqueueTurnCommandHandler,
  InterruptTurnCommandHandler,
  PromoteTurnIntentCommandHandler,
  StartTurnCommandHandler,
  SteerTurnCommandHandler,
  TurnIntentControlCommandHandler
} from './domain/turnCommandHandlers';
import type {
  DeleteCommandPayload,
  DeleteConversationAggregatePayload,
  EditCommandPayload,
  EnqueueTurnCommandPayload,
  InterruptTurnCommandPayload,
  PromoteTurnIntentCommandPayload,
  RenameConversationPayload,
  RetryCommandPayload,
  StartTurnCommandPayload,
  SteerTurnCommandPayload,
  TurnIntentControlCommandPayload
} from './domain/types';
import { ResolveUnknownOutcomeCommandHandler } from './domain/outcomeResolutionHandler';
import {
  DeleteCompressionHandler,
  DismissCheckpointHandler,
  StartManualCompressionHandler,
  ToggleCompressionHandler,
  UpdateCompressionHandler
} from './domain/conversationMaintenanceHandlers';
import {
  CancelToolOperationHandler,
  type CancelToolOperationPayload
} from './domain/toolControlHandlers';
import { committedReadView, fullView } from './domain/internalHandlers';
import { asJson } from './domain/transitionBuilder';
import { DEFAULT_TURN_EXECUTION_POLICY } from './domain/turnExecutionPolicy';
import { DurableFactsIntegrityError } from './domain/durableFactsValidator';
import { resolveForegroundChildToolOwnership } from './domain/childRunOwnership';
import { runGraphCascadeForPolicy, type CancellationPolicyName } from './domain/cancellationIntent';
import { collectTerminateRunGraphClosureRunIds } from './domain/terminateRunGraph';
import { fileChangeResolutionPayload, hydrateFileChangeResolutionPayload } from './interactionResolution';
import {
  ResolveInteractionCommandHandler,
  interactionResolutionIds,
  type ResolveInteractionCommandPayload
} from './domain/interactionHandlers';
import { interactionRequestForTool, uniqueInteractionOwner } from './domain/interactionState';
import {
  CreateConversationHandler,
  ForkConversationHandler,
  type ForkConversationPayload
} from './domain/conversationLifecycleHandlers';

export interface ConversationCommandGatewayOptions {
  backend: FileConversationTransactionBackend;
  adapter: RuntimeAuthorityAdapter;
  storage: StorageCapability;
  webview: WebviewCapability;
  resolveAgentId(conversationId: string, requestedAgentId?: string): string | undefined;
  resolveTurnAuthority(conversationId: string, agentId: string, executionPolicy: JsonValue): EffectiveTurnAuthority;
  policySnapshot?(conversationId: string): JsonValue;
  resolveToolConversationId?(toolCallId: string): string | undefined;
  installCommittedHead?(head: CommittedConversationHead): void | Promise<void>;
  rehydrateCommittedConversation?(conversationId: ConversationId): Promise<void>;
  onCommitted?(conversationIds: readonly ConversationId[]): void;
  /** Upper bound for returning a terminal transport result; the durable transition may still recover later. */
  commandDeadlineMs?: number;
}

type ReliableBridgeMessage = Extract<WebviewToExtensionMessage, {
  type:
    | BridgeMessageType.TurnStart
    | BridgeMessageType.TurnEnqueue
    | BridgeMessageType.TurnSteer
    | BridgeMessageType.TurnInterrupt
    | BridgeMessageType.TurnIntentUpdate
    | BridgeMessageType.TurnIntentCancel
    | BridgeMessageType.TurnIntentReorder
    | BridgeMessageType.TurnIntentPause
    | BridgeMessageType.TurnIntentResume
    | BridgeMessageType.TurnIntentResumeAll
    | BridgeMessageType.TurnIntentPromote
    | BridgeMessageType.MessageEdit
    | BridgeMessageType.MessageDeleteFrom
    | BridgeMessageType.MessageRetryFrom
    | BridgeMessageType.CommandOutcomeResolve
}>;

type ReliableExplicitInteractionMessage = Extract<WebviewToExtensionMessage, {
  type: BridgeMessageType.InteractionResolve;
}>;

type ReliableToolControlMessage = Extract<WebviewToExtensionMessage, {
  type: BridgeMessageType.ToolExecutionCancel;
}>;

type ReliableInteractionMessage = ReliableExplicitInteractionMessage | ReliableToolControlMessage;
type ReliableOutcomeMessage = ReliableInteractionMessage;

type ReliableMaintenanceMessage = Extract<WebviewToExtensionMessage, {
  type:
    | BridgeMessageType.CheckpointDismiss
    | BridgeMessageType.CompressionCreate
    | BridgeMessageType.CompressionDelete
    | BridgeMessageType.CompressionUpdate
    | BridgeMessageType.CompressionRegenerate
    | BridgeMessageType.CompressionDisable
    | BridgeMessageType.CompressionEnable
}>;

const DEFAULT_COMMAND_TERMINAL_DEADLINE_MS = 120_000;
const TURN_INTERRUPT_SCOPE_RETRY_LIMIT = 3;

export interface HostTurnInterruptResult {
  status: 'committed' | 'already_applied' | 'already_satisfied' | 'stale';
  turnId?: string;
  transitionId?: string;
  reason?: string;
}

class RunControlScopeChangedBeforeClaimError extends Error {
  public constructor(message = 'RunGraph closure changed before the control intent acquired its durable claim.') {
    super(message);
    this.name = 'RunControlScopeChangedBeforeClaimError';
  }
}

class RunControlScopeUnstableError extends Error {
  public constructor(runId: RunId, attempts: number) {
    super(`Run ${runId} 的前台子任务关系在 ${attempts} 次加锁复核中持续变化；本次控制请求未写入 source claim，请重试。`);
    this.name = 'RunControlScopeUnstableError';
  }
}

class ConversationCommandDeadlineError extends Error {
  public readonly code = 'command_terminal_deadline_exceeded';

  public constructor(commandId: string, deadlineMs: number) {
    super(`命令 ${commandId} 在 ${deadlineMs}ms 内未取得可证明终态；已转为待恢复状态。`);
    this.name = 'ConversationCommandDeadlineError';
  }
}

/** Webview command boundary: transport receipt is separate from durable Domain Ack. */
export class ConversationCommandGateway {
  private readonly ids = new RuntimeStableIdFactory();
  private readonly managed = new Set<string>();
  private readonly managing = new Map<string, Promise<void>>();
  private readonly internalOwnershipPreparation = new Map<string, Promise<void>>();
  private readonly startTurn = new StartTurnCommandHandler();
  private readonly enqueueTurn = new EnqueueTurnCommandHandler();
  private readonly steerTurn = new SteerTurnCommandHandler();
  private readonly interruptTurn = new InterruptTurnCommandHandler();
  private readonly promoteTurnIntent = new PromoteTurnIntentCommandHandler();
  private readonly turnIntentControl = new TurnIntentControlCommandHandler();
  private readonly rename = new RenameConversationCommandHandler();
  private readonly deleteAggregate = new DeleteConversationAggregateCommandHandler();
  private readonly remove = new DeleteConversationCommandHandler();
  private readonly edit = new EditConversationCommandHandler();
  private readonly retry = new RetryConversationCommandHandler();
  private readonly resolveOutcome = new ResolveUnknownOutcomeCommandHandler();
  private readonly resolveInteraction = new ResolveInteractionCommandHandler();
  private readonly cancelToolOperation = new CancelToolOperationHandler();
  private readonly dismissCheckpoint = new DismissCheckpointHandler();
  private readonly startManualCompression = new StartManualCompressionHandler();
  private readonly deleteCompression = new DeleteCompressionHandler();
  private readonly updateCompression = new UpdateCompressionHandler();
  private readonly toggleCompression = new ToggleCompressionHandler();
  private readonly createConversationHandler = new CreateConversationHandler();
  private readonly forkConversationHandler = new ForkConversationHandler();

  public constructor(private readonly options: ConversationCommandGatewayOptions) {}

  public handles(message: WebviewToExtensionMessage): boolean {
    if (isReliableInteractionMessage(message) || isReliableMaintenanceMessage(message)) return true;
    return isReliableCommandType(message.type)
      || message.type === BridgeMessageType.CommandStatusGet
      || message.type === BridgeMessageType.ConversationHeadGet;
  }

  public handle(clientId: BridgeClientId, message: WebviewToExtensionMessage): boolean {
    if (isReliableMaintenanceMessage(message)) {
      const conversationId = message.payload?.conversationId?.trim();
      if (!conversationId) {
        this.postError(clientId, message.id, message.type, '缺少 conversationId。');
        return true;
      }
      void this.ensureManaged(conversationId as ConversationId)
        .then(() => this.executeMaintenance(clientId, message, conversationId as ConversationId))
        .catch((error) => this.postError(clientId, message.id, message.type, error instanceof Error ? error.message : String(error)));
      return true;
    }
    if (isReliableInteractionMessage(message)) {
      let conversationId: string | undefined;
      try { conversationId = interactionConversationId(message, this.options.resolveToolConversationId); }
      catch (error) {
        this.postError(clientId, message.id, message.type, error instanceof Error ? error.message : String(error));
        return true;
      }
      if (!conversationId) {
        this.postError(clientId, message.id, message.type, '无法解析 ToolCall 所属 conversation。');
        return true;
      }
      void this.ensureManaged(conversationId as ConversationId)
        .then(() => message.type === BridgeMessageType.InteractionResolve
          ? this.executeExplicitInteraction(clientId, message, conversationId as ConversationId)
          : this.executeToolControl(clientId, message, conversationId as ConversationId))
        .catch((error) => this.postInteractionFailure(clientId, message, conversationId as ConversationId, error));
      return true;
    }
    if (message.type === BridgeMessageType.CommandStatusGet) {
      if (!message.payload?.commandId || !isStableId(message.payload.commandId, 'command')) {
        this.postError(clientId, message.id, message.type, '无效的 commandId。');
        return true;
      }
      const commandId = message.payload.commandId as CommandId;
      void this.postStatus(clientId, commandId, message.id)
        .catch((error) => this.postStatusFailure(clientId, commandId, message.id, error));
      return true;
    }
    if (message.type === BridgeMessageType.ConversationHeadGet) {
      if (!message.payload?.conversationId) {
        this.postError(clientId, message.id, message.type, '缺少 conversationId。');
        return true;
      }
      void this.postHead(clientId, message.payload.conversationId as ConversationId, message.id);
      return true;
    }
    if (!isReliableCommandMessage(message)) return false;

    const metadata = message.payload?.command;
    if (!metadata || !isStableId(metadata.commandId, 'command') || !Number.isInteger(metadata.expectedVersion) || metadata.expectedVersion < 0 || !Number.isFinite(metadata.issuedAt)) {
      this.postError(clientId, message.id, message.type, '命令缺少有效的 commandId、expectedVersion 或 issuedAt。');
      return true;
    }
    this.options.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.CommandReceipt,
      channel: 'command',
      correlationId: message.id,
      payload: { commandId: metadata.commandId as CommandId, status: 'received' }
    });
    void this.executeWithTerminalDeadline(clientId, message)
      .catch((error) => this.postServiceFailure(clientId, message, error));
    return true;
  }

  public managedConversationIds(): readonly string[] {
    return [...this.managed].sort((left, right) => left.localeCompare(right));
  }

  public async readCommittedConversationFacts(conversationId: ConversationId) {
    await this.ensureManaged(conversationId);
    return this.loadCommittedFacts(conversationId);
  }

  public async createConversation(conversationId: ConversationId, title?: string): Promise<void> {
    if (this.managed.has(conversationId) || await this.options.adapter.readRuntime(conversationId)) {
      throw new Error(`Conversation already exists: ${conversationId}`);
    }
    const sourceKey = `internal:conversation-create:${conversationId}`;
    const result = await this.options.backend.executeInternal({
      command: {
        sourceKey,
        type: 'conversation.create',
        scope: { kind: 'conversation', id: conversationId },
        occurredAt: Date.now(),
        payload: cloneJson({ conversationId, ...(title?.trim() ? { title: title.trim() } : {}) })
      },
      handler: this.createConversationHandler,
      createPlanningContext: ({ transitionId, now }) => ({ transitionId, now, policySnapshot: null, ids: {} })
    });
    if (result.status !== 'committed' && result.status !== 'already_applied') {
      throw new Error(`Conversation creation did not commit: ${conversationId} (${result.status})`);
    }
    this.postInternalPatches(result.patches, result.heads, sourceKey);
    await this.publishManagedConversation(conversationId);
    this.options.onCommitted?.([conversationId]);
  }

  public async forkConversation(
    sourceConversationId: ConversationId,
    targetConversationId: ConversationId,
    throughMessageId: string
  ): Promise<void> {
    await this.ensureManaged(sourceConversationId);
    if (this.managed.has(targetConversationId) || await this.options.adapter.readRuntime(targetConversationId)) {
      throw new Error(`Fork target Conversation already exists: ${targetConversationId}`);
    }
    const payload: ForkConversationPayload = {
      sourceConversationId,
      targetConversationId,
      throughMessageId
    };
    const sourceKey = `internal:conversation-fork:${targetConversationId}`;
    const result = await this.options.backend.executeInternal({
      command: {
        sourceKey,
        type: 'conversation.fork',
        scope: { kind: 'conversation', id: sourceConversationId },
        occurredAt: Date.now(),
        payload: cloneJson(payload)
      },
      handler: this.forkConversationHandler,
      createPlanningContext: ({ transitionId, now }) => ({ transitionId, now, policySnapshot: null, ids: {} })
    });
    if (result.status !== 'committed' && result.status !== 'already_applied') {
      throw new Error(`Conversation fork did not commit: ${targetConversationId} (${result.status})`);
    }
    this.postInternalPatches(result.patches, result.heads, sourceKey);
    await this.publishManagedConversation(targetConversationId);
    this.options.onCommitted?.(result.heads.map((head) => head.conversationId));
  }

  public async renameConversationFromHost(conversationId: ConversationId, title: string): Promise<boolean> {
    await this.ensureManaged(conversationId);
    const head = await this.options.backend.conversationHead(conversationId);
    const commandId = this.ids.nextCommandId();
    const payload: RenameConversationPayload = { conversationId, title };
    const result = await this.options.backend.execute({
      command: {
        commandId,
        type: 'conversation.rename',
        scope: { kind: 'conversation', id: conversationId },
        expectedVersions: [{ conversationId, version: head.version }],
        issuedAt: Date.now(),
        payload: payload as unknown as JsonValue
      },
      handler: this.rename,
      createPlanningContext: ({ transitionId, now }) => ({ transitionId, now, policySnapshot: null, ids: {} })
    });
    return this.finishHostCommand(result);
  }

  public async cancelConversationFromHost(
    conversationId: ConversationId,
    requestId = createMessageId()
  ): Promise<HostTurnInterruptResult> {
    await this.ensureManaged(conversationId);
    const facts = await this.loadCommittedFacts(conversationId);
    const leases = facts.executionLeases.filter((lease) => lease.conversationId === conversationId && lease.state !== 'released');
    if (leases.length > 1) throw new DurableFactsIntegrityError([`Conversation ${conversationId} owns multiple active ExecutionLeases.`]);
    const lease = leases[0];
    if (!lease) return { status: 'already_satisfied', reason: 'no_active_execution' };

    // Freeze Turn identity and lease epoch exactly once. Scope retries may refresh HEAD/closure only;
    // they can never retarget the host Stop to a newer Turn.
    const sourceKey = `internal:host:${requestId}:turn-interrupt`;
    const ack = await this.commitTurnInterrupt({
      conversationId,
      turnId: lease.turnId,
      leaseEpoch: lease.epoch,
      cascadeChildAgents: false,
      sourceKey,
      occurredAt: Date.now()
    });
    return hostTurnInterruptResult(ack, lease.turnId);
  }

  public async deleteConversationFromHost(conversationId: ConversationId): Promise<boolean> {
    await this.ensureManaged(conversationId);
    const head = await this.options.backend.conversationHead(conversationId);
    const executionViewSpec = await this.resolveGraphExecutionView(
      conversationId,
      'conversation.delete_aggregate',
      { policy: 'full_tree_stop' }
    );
    const payload: DeleteConversationAggregatePayload = { conversationId };
    const result = await this.options.backend.execute({
      command: {
        commandId: this.ids.nextCommandId(),
        type: 'conversation.delete_aggregate',
        scope: { kind: 'conversation', id: conversationId },
        expectedVersions: [{ conversationId, version: head.version }],
        issuedAt: Date.now(),
        payload: payload as unknown as JsonValue
      },
      handler: this.deleteAggregate,
      executionViewSpec,
      createPlanningContext: ({ transitionId, now }) => ({ transitionId, now, policySnapshot: null, ids: {} })
    });
    return this.finishHostCommand(result);
  }

  /** Reserves aggregate/file ownership before a multi-scope internal transition creates a child. */
  public async applyToolChangeFromEditor(conversationId: ConversationId, toolCallId: ToolCallId): Promise<void> {
    await this.ensureManaged(conversationId);
    const facts = await this.loadCommittedFacts(conversationId);
    const matched = interactionRequestForTool(facts, toolCallId, 'patch_approval');
    if (!matched) return;
    const request = matched.request;
    const sourceKey = `internal:editor-save:interaction:${request.id}:${request.revision}`;
    const completedAt = Date.now();
    const hydrated = await hydrateFileChangeResolutionPayload(fileChangeResolutionPayload({
      conversationId,
      toolCallId,
      interactionRequestId: request.id,
      interactionRevision: request.revision,
      decision: 'accept',
      actor: 'user',
      actorId: 'editor-save',
      commandId: sourceKey,
      completedAt
    }), facts, this.options.storage);
    if (!hydrated.proposalArtifactId || !hydrated.proposalContentHash || hydrated.proposal === undefined) {
      throw new Error(`Patch Interaction ${request.id} 无法取得不可变 proposal attestation。`);
    }
    const ids = interactionResolutionIds(request.id, request.revision);
    const payload: ResolveInteractionCommandPayload = {
      conversationId,
      interactionRequestId: request.id,
      interactionRevision: request.revision,
      ownerTurnId: matched.owner.turnId,
      responseId: ids.responseId,
      decision: 'accept',
      actor: 'user',
      actorId: 'editor-save',
      commandId: sourceKey,
      response: asJson({ source: 'editor-save' }),
      completedAt,
      ...ids.execution,
      ...ids.continuation,
      patch: {
        proposalArtifactId: hydrated.proposalArtifactId,
        proposalContentHash: hydrated.proposalContentHash,
        proposal: cloneJson(hydrated.proposal)
      }
    };
    const result = await this.options.backend.executeInternal({
      command: {
        sourceKey,
        type: 'interaction.resolve',
        scope: { kind: 'conversation', id: conversationId },
        occurredAt: completedAt,
        payload: cloneJson(payload)
      },
      handler: this.resolveInteraction,
      createPlanningContext: ({ transitionId, now }) => ({ transitionId, now, policySnapshot: this.options.policySnapshot?.(conversationId) ?? DEFAULT_TURN_EXECUTION_POLICY, ids: {} })
    });
    this.postInternalPatches(result.patches, result.heads, sourceKey);
    if (result.status === 'committed' || result.status === 'already_applied') this.options.onCommitted?.(result.heads.map((head) => head.conversationId));
  }

  public async prepareInternalConversation(conversationId: ConversationId): Promise<void> {
    if (this.managed.has(conversationId)) return;
    const current = this.internalOwnershipPreparation.get(conversationId);
    if (current) return current;
    const preparation = this.prepareCommittedConversation(conversationId, false)
      .finally(() => this.internalOwnershipPreparation.delete(conversationId));
    this.internalOwnershipPreparation.set(conversationId, preparation);
    return preparation;
  }

  /** Publishes a conversation only after its runtime-authority postimage is storage_committed. */
  public async adoptCommittedInternalConversation(conversationId: ConversationId): Promise<void> {
    if (!this.options.adapter.hasKnownRuntime(conversationId) && !await this.options.adapter.readRuntime(conversationId)) {
      throw new Error(`Committed child runtime is missing: ${conversationId}`);
    }
    await this.publishManagedConversation(conversationId);
  }

  /** Startup admission accepts only conversations already committed by the transaction backend. */
  public async adoptExistingRuntimeConversations(
    conversationIds: Iterable<string>,
    options: { rehydrateConversationIds?: Iterable<string> } = {}
  ): Promise<void> {
    const ids = [...new Set(conversationIds)].sort() as ConversationId[];
    const rehydrate = new Set(options.rehydrateConversationIds ?? []);
    for (const conversationId of ids) {
      if (!this.options.adapter.hasKnownRuntime(conversationId) && !await this.options.adapter.readRuntime(conversationId)) {
        throw new Error(`Startup projected a conversation without committed runtime authority: ${conversationId}`);
      }
      if (rehydrate.has(conversationId)) await this.options.rehydrateCommittedConversation?.(conversationId);
      await this.publishManagedConversation(conversationId);
    }
    this.options.adapter.validateCrossScopeLinksForStartup(ids, await this.readAnswerBridgeLookup());
  }

  public async postHead(clientId: BridgeClientId, conversationId: ConversationId, correlationId?: string): Promise<void> {
    await this.ensureManaged(conversationId);
    const head = await this.options.backend.conversationHead(conversationId);
    this.options.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.ConversationHeadSnapshot,
      channel: 'state',
      scope: { kind: 'conversation', id: conversationId },
      correlationId,
      payload: {
        conversationId,
        version: head.version,
        streamId: head.streamId,
        patchNextSeq: head.patchNextSeq
      }
    });
  }

  private async executeWithTerminalDeadline(clientId: BridgeClientId, message: ReliableBridgeMessage): Promise<void> {
    const deadlineMs = this.options.commandDeadlineMs ?? DEFAULT_COMMAND_TERMINAL_DEADLINE_MS;
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return this.execute(clientId, message);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.execute(clientId, message),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ConversationCommandDeadlineError(message.payload!.command.commandId, deadlineMs)), deadlineMs);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async execute(clientId: BridgeClientId, message: ReliableBridgeMessage): Promise<void> {
    const conversationId = message.payload!.conversationId as ConversationId;
    await this.ensureManaged(conversationId);
    const command = commandEnvelope(message);
    const executionViewSpec = commandNeedsClosedRunGraph(message)
      ? await this.resolveGraphExecutionView(conversationId, message.type, {
          ...(message.type === BridgeMessageType.TurnInterrupt
            ? { rootRunIds: [requireStableId(message.payload!.turnId, 'run') as RunId] }
            : {}),
          policy: cancellationPolicyForCommand(message)
        })
      : undefined;
    const policySnapshot = this.options.policySnapshot?.(conversationId) ?? DEFAULT_TURN_EXECUTION_POLICY;

    let result: Awaited<ReturnType<FileConversationTransactionBackend['execute']>>;
    switch (message.type) {
      case BridgeMessageType.TurnInterrupt: {
        const payload = message.payload!;
        const interruptPayload: InterruptTurnCommandPayload = {
          conversationId,
          turnId: requireStableId(payload.turnId, 'run') as RunId,
          leaseEpoch: payload.leaseEpoch,
          cascadeChildAgents: payload.cascadeChildAgents === true
        };
        result = await this.options.backend.execute({
          command: { ...command, type: 'turn.interrupt', payload: interruptPayload as unknown as JsonValue },
          handler: this.interruptTurn,
          executionViewSpec,
          preClaimValidate: ({ view }) => {
            const cascade = runGraphCascadeForPolicy(interruptPayload.cascadeChildAgents ? 'full_tree_stop' : 'conversation_stop');
            const observedClosureTurnIds = collectTerminateRunGraphClosureRunIds(view.facts, {
              rootRunIds: [interruptPayload.turnId],
              cascadeForegroundChildren: cascade.cascadeForegroundChildren,
              cascadeBackgroundChildren: cascade.cascadeBackgroundChildren
            });
            if (!sameStringIds(observedClosureTurnIds, executionViewSpec?.resolvedClosureRunIds ?? [])) {
              throw new RunControlScopeChangedBeforeClaimError();
            }
          },
          createPlanningContext: ({ transitionId, now }) => ({ transitionId, now, policySnapshot, ids: {} })
        });
        break;
      }
      case BridgeMessageType.TurnStart: {
        const payload = message.payload!;
        const content = normalizeUserContent(payload.content, payload.text);
        const agentId = this.options.resolveAgentId(payload.conversationId, payload.agentId);
        if (!agentId) throw new Error(`Conversation ${payload.conversationId} has no selected Agent.`);
        const authoritySnapshot = cloneAuthority(this.options.resolveTurnAuthority(payload.conversationId, agentId, policySnapshot));
        result = await this.options.backend.execute({
          command: { ...command, type: 'turn.start', payload: { conversationId, content, agentId } as unknown as JsonValue },
          handler: this.startTurn,
          executionViewSpec,
          prepareCommand: async (prepared) => {
            const next = prepared.payload as unknown as StartTurnCommandPayload;
            return {
              ...prepared,
              payload: { ...next, content: await this.options.storage.ingestMessageContentAttachments(next.content) } as unknown as JsonValue
            };
          },
          createPlanningContext: ({ transitionId, now }) => ({
            transitionId,
            now,
            policySnapshot: cloneJson(authoritySnapshot.executionPolicy),
            authoritySnapshot,
            ids: {
              turnId: this.ids.nextRunId(),
              messageId: this.ids.nextMessageId(),
              revisionId: this.ids.nextMessageRevisionId(),
              authoritySnapshotId: this.ids.nextAuthoritySnapshotId(),
              operationId: this.ids.nextOperationId(),
              attemptId: this.ids.nextAttemptId(),
              effectIntentId: this.ids.nextEffectIntentId()
            }
          })
        });
        break;
      }
      case BridgeMessageType.TurnEnqueue: {
        const payload = message.payload!;
        const content = normalizeUserContent(payload.content, payload.text);
        const agentId = this.options.resolveAgentId(payload.conversationId, payload.agentId);
        if (!agentId) throw new Error(`Conversation ${payload.conversationId} has no selected Agent.`);
        const authoritySnapshot = cloneAuthority(this.options.resolveTurnAuthority(payload.conversationId, agentId, policySnapshot));
        result = await this.options.backend.execute({
          command: { ...command, type: 'turn.enqueue', payload: { conversationId, content, agentId } as unknown as JsonValue },
          handler: this.enqueueTurn,
          executionViewSpec,
          prepareCommand: async (prepared) => {
            const next = prepared.payload as unknown as EnqueueTurnCommandPayload;
            return {
              ...prepared,
              payload: { ...next, content: await this.options.storage.ingestMessageContentAttachments(next.content) } as unknown as JsonValue
            };
          },
          createPlanningContext: ({ transitionId, now }) => ({
            transitionId,
            now,
            policySnapshot: cloneJson(authoritySnapshot.executionPolicy),
            authoritySnapshot,
            ids: {
              intentId: this.ids.nextTurnIntentId(),
              revisionId: this.ids.nextTurnIntentRevisionId(),
              executionPresetRevisionId: this.ids.nextRelationId()
            }
          })
        });
        break;
      }
      case BridgeMessageType.TurnSteer: {
        const payload = message.payload!;
        const content = normalizeUserContent(payload.content, payload.text);
        result = await this.options.backend.execute({
          command: {
            ...command,
            type: 'turn.steer',
            payload: {
              conversationId,
              targetTurnId: requireStableId(payload.targetTurnId, 'run') as RunId,
              targetLeaseEpoch: payload.targetLeaseEpoch,
              fallback: payload.fallback,
              content
            } as unknown as JsonValue
          },
          handler: this.steerTurn,
          executionViewSpec,
          prepareCommand: async (prepared) => {
            const next = prepared.payload as unknown as SteerTurnCommandPayload;
            return {
              ...prepared,
              payload: { ...next, content: await this.options.storage.ingestMessageContentAttachments(next.content) } as unknown as JsonValue
            };
          },
          createPlanningContext: ({ transitionId, now }) => ({
            transitionId,
            now,
            policySnapshot,
            ids: { pendingInputId: this.ids.nextPendingTurnInputId() }
          })
        });
        break;
      }
      case BridgeMessageType.TurnIntentPromote: {
        const payload = message.payload!;
        const promotePayload: PromoteTurnIntentCommandPayload = {
          conversationId,
          intentId: requireStableId(payload.intentId, 'turnIntent'),
          intentRowVersion: payload.rowVersion,
          replaceActive: payload.replaceActive === true,
          ...(payload.expectedActiveTurnId ? { expectedActiveTurnId: requireStableId(payload.expectedActiveTurnId, 'run') as RunId } : {}),
          ...(payload.expectedLeaseEpoch !== undefined ? { expectedLeaseEpoch: payload.expectedLeaseEpoch } : {})
        };
        result = await this.options.backend.execute({
          command: { ...command, type: 'turnIntent.promote', payload: promotePayload as unknown as JsonValue },
          handler: this.promoteTurnIntent,
          executionViewSpec,
          createPlanningContext: ({ transitionId, now }) => ({
            transitionId,
            now,
            policySnapshot,
            ids: {
              turnId: this.ids.nextRunId(),
              messageId: this.ids.nextMessageId(),
              revisionId: this.ids.nextMessageRevisionId(),
              authoritySnapshotId: this.ids.nextAuthoritySnapshotId(),
              operationId: this.ids.nextOperationId(),
              attemptId: this.ids.nextAttemptId(),
              effectIntentId: this.ids.nextEffectIntentId()
            }
          })
        });
        break;
      }
      case BridgeMessageType.TurnIntentUpdate:
      case BridgeMessageType.TurnIntentCancel:
      case BridgeMessageType.TurnIntentReorder:
      case BridgeMessageType.TurnIntentPause:
      case BridgeMessageType.TurnIntentResume:
      case BridgeMessageType.TurnIntentResumeAll: {
        const payload = message.payload!;
        const action: TurnIntentControlCommandPayload['action'] = message.type === BridgeMessageType.TurnIntentUpdate
          ? 'update'
          : message.type === BridgeMessageType.TurnIntentCancel
            ? 'cancel'
            : message.type === BridgeMessageType.TurnIntentReorder
              ? 'reorder'
              : message.type === BridgeMessageType.TurnIntentPause
                ? 'pause'
                : message.type === BridgeMessageType.TurnIntentResume
                  ? 'resume'
                  : 'resume_all';
        const controlPayload: TurnIntentControlCommandPayload = action === 'reorder'
          ? {
              conversationId,
              action,
              orderedIntents: (payload as Extract<typeof payload, { intents: unknown }>).intents.map((item) => ({
                intentId: requireStableId(item.intentId, 'turnIntent'),
                rowVersion: item.rowVersion
              }))
            }
          : action === 'resume_all'
            ? { conversationId, action }
            : {
                conversationId,
                action,
                intentId: requireStableId((payload as { intentId: string }).intentId, 'turnIntent'),
                intentRowVersion: (payload as { rowVersion: number }).rowVersion,
                ...(action === 'update' ? { content: normalizeUserContent((payload as { content?: MessageContent }).content, (payload as { text?: string }).text) } : {})
              };
        result = await this.options.backend.execute({
          command: { ...command, type: `turnIntent.${action}`, payload: controlPayload as unknown as JsonValue },
          handler: this.turnIntentControl,
          executionViewSpec,
          ...(controlPayload.content ? {
            prepareCommand: async (prepared: CommandEnvelope<JsonValue>) => {
              const next = prepared.payload as unknown as TurnIntentControlCommandPayload;
              return {
                ...prepared,
                payload: { ...next, content: await this.options.storage.ingestMessageContentAttachments(next.content!) } as unknown as JsonValue
              };
            }
          } : {}),
          createPlanningContext: ({ transitionId, now }) => ({
            transitionId,
            now,
            policySnapshot,
            ids: { revisionId: this.ids.nextTurnIntentRevisionId() }
          })
        });
        break;
      }
      case BridgeMessageType.MessageDeleteFrom: {
        const payload = message.payload!;
        result = await this.options.backend.execute({
          command: { ...command, type: 'conversation.delete', payload: { conversationId, messageId: payload.messageId } as unknown as JsonValue },
          handler: this.remove,
          executionViewSpec,
          createPlanningContext: ({ transitionId, now }) => ({ transitionId, now, policySnapshot, ids: {} })
        });
        break;
      }
      case BridgeMessageType.MessageEdit: {
        const payload = message.payload!;
        result = await this.options.backend.execute({
          command: {
            ...command,
            type: 'conversation.edit',
            payload: {
              conversationId,
              messageId: payload.messageId,
              content: normalizeUserContent(payload.content, payload.text),
              deleteFollowing: payload.deleteFollowing === true,
              restartRun: payload.runAfterEdit === true
            } as unknown as JsonValue
          },
          handler: this.edit,
          executionViewSpec,
          prepareCommand: async (prepared) => {
            const next = prepared.payload as unknown as EditCommandPayload;
            return {
              ...prepared,
              payload: { ...next, content: await this.options.storage.ingestMessageContentAttachments(next.content) } as unknown as JsonValue
            };
          },
          createPlanningContext: ({ transitionId, now }) => ({
            transitionId,
            now,
            policySnapshot,
            ids: {
              revisionId: this.ids.nextMessageRevisionId(),
              runId: this.ids.nextRunId(),
              operationId: this.ids.nextOperationId(),
              attemptId: this.ids.nextAttemptId(),
              effectIntentId: this.ids.nextEffectIntentId()
            }
          })
        });
        break;
      }
      case BridgeMessageType.MessageRetryFrom: {
        const payload = message.payload!;
        result = await this.options.backend.execute({
          command: { ...command, type: 'conversation.retry', payload: { conversationId, messageId: payload.messageId } as unknown as JsonValue },
          handler: this.retry,
          executionViewSpec,
          createPlanningContext: ({ transitionId, now }) => ({
            transitionId,
            now,
            policySnapshot,
            ids: {
              runId: this.ids.nextRunId(),
              operationId: this.ids.nextOperationId(),
              attemptId: this.ids.nextAttemptId(),
              effectIntentId: this.ids.nextEffectIntentId()
            }
          })
        });
        break;
      }
      case BridgeMessageType.CommandOutcomeResolve: {
        const payload = message.payload!;
        result = await this.options.backend.execute({
          command: {
            ...command,
            type: 'operation.resolve_unknown',
            payload: {
              conversationId,
              operationId: payload.operationId,
              resolution: payload.resolution,
              ...(payload.evidenceRef ? { evidenceRef: payload.evidenceRef } : {}),
              ...(payload.verifiedResult !== undefined ? { verifiedResult: payload.verifiedResult } : {})
            } as JsonValue
          },
          handler: this.resolveOutcome,
          executionViewSpec,
          createPlanningContext: ({ transitionId, now }) => ({
            transitionId,
            now,
            policySnapshot,
            ids: {
              operationId: this.ids.nextOperationId(),
              attemptId: this.ids.nextAttemptId(),
              effectIntentId: this.ids.nextEffectIntentId(),
              responseMessageId: this.ids.nextMessageId(),
              responseRevisionId: this.ids.nextMessageRevisionId(),
              invocationId: this.ids.nextInvocationId(),
              requestId: this.ids.nextRequestId()
            }
          })
        });
        break;
      }
    }
    this.postCommittedPatches(result.patches, result.ack);
    if (result.ack.status !== 'rejected') this.options.onCommitted?.(result.ack.controlHeads.map((head) => head.conversationId));
    this.options.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.CommandResult,
      channel: 'command',
      correlationId: message.id,
      payload: { ack: result.ack }
    });
  }

  private async resolveGraphExecutionView(
    conversationId: ConversationId,
    kind: string,
    options: { rootRunIds?: readonly RunId[]; policy?: CancellationPolicyName } = {}
  ) {
    const cascade = runGraphCascadeForPolicy(options.policy ?? 'conversation_stop');
    const resolved = await this.options.adapter.resolveRunGraphScope(conversationId, {
      ...(options.rootRunIds ? { rootRunIds: options.rootRunIds } : {}),
      includeBackground: cascade.cascadeBackgroundChildren
    }, this.runtimeReadAccess());
    const closure = resolved.rootRunIds.length > 0
      ? await this.options.adapter.resolveRunGraphClosure(
          conversationId,
          resolved.rootRunIds,
          cascade.cascadeBackgroundChildren,
          this.runtimeReadAccess()
        )
      : undefined;
    const conversationIds = closure?.conversationIds ?? resolved.conversationIds;
    for (const scope of conversationIds) {
      if (!this.managed.has(scope)) throw new Error(`Foreground Turn graph scope is not reliability-owned: ${scope}`);
    }
    const base = fullView(kind, conversationId);
    return {
      ...base,
      conversations: conversationIds,
      timeline: conversationIds.map((id) => ({ conversationId: id, throughTail: true })),
      closedRunGraphRoots: resolved.rootRunIds,
      closedRunGraphModes: cascade.cascadeBackgroundChildren ? ['foreground', 'background'] as const : ['foreground'] as const,
      storageResourceKeys: [
        ANSWER_BRIDGE_RESOURCE_KEY,
        CONVERSATION_ATTACHMENTS_RESOURCE_KEY
      ],
      mergeConversationFacts: true,
      aggregateRootConversationId: conversationId,
      resolvedClosureRunIds: closure?.nodes.map((node) => node.runId).sort() ?? []
    };
  }

  private async resolveTurnInterruptExecutionCandidate(
    conversationId: ConversationId,
    turnId: RunId,
    cascadeChildAgents: boolean
  ): Promise<{ executionViewSpec: ReturnType<typeof fullView>; closureTurnIds: RunId[] }> {
    const policy: CancellationPolicyName = cascadeChildAgents ? 'full_tree_stop' : 'conversation_stop';
    const cascade = runGraphCascadeForPolicy(policy);
    const closure = await this.options.adapter.resolveRunGraphClosure(
      conversationId,
      [turnId],
      cascade.cascadeBackgroundChildren,
      this.runtimeReadAccess()
    );
    for (const scope of closure.conversationIds) {
      if (!this.managed.has(scope)) throw new Error(`Turn interrupt graph scope is not reliability-owned: ${scope}`);
    }
    const base = fullView('turn.interrupt', conversationId);
    return {
      executionViewSpec: {
        ...base,
        conversations: closure.conversationIds,
        timeline: closure.conversationIds.map((id) => ({ conversationId: id, throughTail: true })),
        closedRunGraphRoots: [turnId],
        closedRunGraphModes: cascade.cascadeBackgroundChildren
          ? ['foreground', 'background'] as const
          : ['foreground'] as const,
        storageResourceKeys: [ANSWER_BRIDGE_RESOURCE_KEY, CONVERSATION_ATTACHMENTS_RESOURCE_KEY],
        mergeConversationFacts: true,
        aggregateRootConversationId: conversationId
      },
      closureTurnIds: closure.nodes.map((node) => node.runId).sort()
    };
  }

  private async commitTurnInterrupt(input: {
    conversationId: ConversationId;
    turnId: RunId;
    leaseEpoch: number;
    cascadeChildAgents: boolean;
    sourceKey: string;
    occurredAt: number;
  }): Promise<CommandAck<JsonValue>> {
    const policy: CancellationPolicyName = input.cascadeChildAgents ? 'full_tree_stop' : 'conversation_stop';
    const cascade = runGraphCascadeForPolicy(policy);
    const commandId = stableIdFromSeed('command', input.sourceKey);

    for (let attempt = 1; attempt <= TURN_INTERRUPT_SCOPE_RETRY_LIMIT; attempt += 1) {
      try {
        const candidate = await this.resolveTurnInterruptExecutionCandidate(
          input.conversationId,
          input.turnId,
          input.cascadeChildAgents
        );
        const head = await this.options.backend.conversationHead(input.conversationId);
        const payload: InterruptTurnCommandPayload = {
          conversationId: input.conversationId,
          turnId: input.turnId,
          leaseEpoch: input.leaseEpoch,
          cascadeChildAgents: input.cascadeChildAgents
        };
        const result = await this.options.backend.execute({
          command: {
            commandId,
            type: 'turn.interrupt',
            scope: { kind: 'conversation', id: input.conversationId },
            expectedVersions: [{ conversationId: input.conversationId, version: head.version }],
            issuedAt: input.occurredAt,
            payload: cloneJson(payload)
          },
          handler: this.interruptTurn,
          executionViewSpec: candidate.executionViewSpec,
          preClaimValidate: ({ view }) => {
            const observedClosureTurnIds = collectTerminateRunGraphClosureRunIds(view.facts, {
              rootRunIds: [input.turnId],
              cascadeForegroundChildren: cascade.cascadeForegroundChildren,
              cascadeBackgroundChildren: cascade.cascadeBackgroundChildren
            });
            if (!sameStringIds(observedClosureTurnIds, candidate.closureTurnIds)) {
              throw new RunControlScopeChangedBeforeClaimError();
            }
          },
          createPlanningContext: ({ transitionId, now }) => ({
            transitionId,
            now,
            policySnapshot: this.options.policySnapshot?.(input.conversationId) ?? DEFAULT_TURN_EXECUTION_POLICY,
            ids: {}
          })
        });
        this.postCommittedPatches(result.patches, result.ack);
        if (result.ack.status !== 'rejected') {
          this.options.onCommitted?.(result.ack.controlHeads.map((head) => head.conversationId));
        }
        return result.ack as CommandAck<JsonValue>;
      } catch (error) {
        const scopeChanged = error instanceof RunControlScopeChangedBeforeClaimError
          || error instanceof DurableScopeIncompleteError
          || error instanceof RunGraphClosureIntegrityError;
        if (!scopeChanged) throw error;
        if (attempt === TURN_INTERRUPT_SCOPE_RETRY_LIMIT) {
          throw new RunControlScopeUnstableError(input.turnId, TURN_INTERRUPT_SCOPE_RETRY_LIMIT);
        }
      }
    }
    throw new RunControlScopeUnstableError(input.turnId, TURN_INTERRUPT_SCOPE_RETRY_LIMIT);
  }


  private async executeMaintenance(clientId: BridgeClientId, message: ReliableMaintenanceMessage, conversationId: ConversationId): Promise<void> {
    const sourceKey = `internal:webview:${message.id}`;
    let type: string;
    let payload: JsonValue;
    let handler: Parameters<FileConversationTransactionBackend['executeInternal']>[0]['handler'];
    switch (message.type) {
      case BridgeMessageType.CompressionCreate:
      case BridgeMessageType.CompressionRegenerate: {
        const request = message.type === BridgeMessageType.CompressionCreate
          ? {
              startMessageId: message.payload!.startMessageId,
              endMessageId: message.payload!.endMessageId,
              methodConfigId: message.payload!.methodConfigId,
              methodKind: message.payload!.methodKind
            }
          : {
              replaceBlockId: message.payload!.blockId,
              methodConfigId: message.payload!.methodConfigId
            };
        type = 'compression.manual.start';
        payload = cloneJson({
          conversationId,
          request,
          seed: sourceKey,
          operationId: stableIdFromSeed('operation', `${sourceKey}:compression-operation`),
          attemptId: stableIdFromSeed('attempt', `${sourceKey}:compression-attempt`),
          effectIntentId: stableIdFromSeed('effectIntent', `${sourceKey}:compression-effect`)
        });
        handler = this.startManualCompression;
        break;
      }
      case BridgeMessageType.CheckpointDismiss:
        type = 'checkpoint.dismiss';
        payload = cloneJson({ conversationId, checkpointId: message.payload!.checkpointId });
        handler = this.dismissCheckpoint;
        break;
      case BridgeMessageType.CompressionDelete:
        type = 'compression.delete';
        payload = cloneJson({ conversationId, blockId: message.payload!.blockId });
        handler = this.deleteCompression;
        break;
      case BridgeMessageType.CompressionUpdate:
        type = 'compression.update';
        payload = cloneJson({
          ...message.payload!,
          conversationId,
          variantId: stableIdFromSeed('relation', `${sourceKey}:compression-variant`)
        });
        handler = this.updateCompression;
        break;
      case BridgeMessageType.CompressionDisable:
      case BridgeMessageType.CompressionEnable:
        type = 'compression.toggle';
        payload = cloneJson({
          conversationId,
          blockId: message.payload!.blockId,
          enabled: message.type === BridgeMessageType.CompressionEnable
        });
        handler = this.toggleCompression;
        break;
    }
    const result = await this.options.backend.executeInternal({
      command: {
        sourceKey,
        type,
        scope: { kind: 'conversation', id: conversationId },
        occurredAt: Date.now(),
        payload
      },
      handler: handler as never,
      createPlanningContext: ({ transitionId, now }) => ({
        transitionId,
        now,
        policySnapshot: this.options.policySnapshot?.(conversationId) ?? DEFAULT_TURN_EXECUTION_POLICY,
        ids: {}
      })
    });
    this.postInternalPatches(result.patches, result.heads, sourceKey);
    if (result.status === 'committed' || result.status === 'already_applied') {
      this.options.onCommitted?.(result.heads.map((head) => head.conversationId));
    } else if (result.status === 'stale') {
      this.postError(clientId, message.id, message.type, internalResultReason(result.result) ?? '维护操作与当前对话状态冲突。');
    }
  }

  private async executeExplicitInteraction(
    clientId: BridgeClientId,
    message: ReliableExplicitInteractionMessage,
    conversationId: ConversationId
  ): Promise<void> {
    const input = message.payload as InteractionResolvePayload;
    const interactionRequestId = requireStableId<'InteractionRequestId'>(
      input.interactionRequestId,
      'interactionRequest'
    ) as InteractionRequestId;
    const ownerTurnId = requireStableId<'RunId'>(input.ownerTurnId, 'run') as RunId;
    if (!Number.isInteger(input.interactionRevision) || input.interactionRevision < 1) {
      throw new Error(`InteractionRequest revision 无效：${input.interactionRevision}`);
    }
    const facts = await this.loadCommittedFacts(conversationId);
    const request = facts.interactionRequests.find((candidate) => candidate.id === interactionRequestId);
    if (!request) throw new Error(`未找到 InteractionRequest：${interactionRequestId}`);
    const owner = uniqueInteractionOwner(facts, interactionRequestId);
    if (!owner) throw new Error(`InteractionRequest ${interactionRequestId} 缺少 owner link。`);
    await this.executeResolvedInteraction(clientId, message, conversationId, {
      request,
      ownerTurnId,
      sourceToolCallId: owner.sourceToolCallId,
      interactionRevision: input.interactionRevision,
      decision: input.decision,
      response: cloneJson(input.response)
    });
  }

  private async executeToolControl(
    clientId: BridgeClientId,
    message: ReliableToolControlMessage,
    conversationId: ConversationId
  ): Promise<void> {
    const input = message.payload as ToolDecisionPayload;
    const toolCallId = requireStableId<'ToolCallId'>(input.toolCallId, 'toolCall') as ToolCallId;
    if (message.type === BridgeMessageType.ToolExecutionCancel) {
      const sourceKey = `internal:webview:${message.id}`;
      const continuation = controlContinuationIds(sourceKey);
      const childCancellation = await this.resolveForegroundToolChildCancellation(conversationId, toolCallId);
      const payload = cloneJson({
        conversationId,
        toolCallId,
        reason: input.reason?.trim() || '用户终止工具执行。',
        completedAt: Date.now(),
        ...continuation,
        ...(childCancellation ? { ownedChild: childCancellation.ownedChild } : {})
      } satisfies CancelToolOperationPayload);
      await this.commitInteraction(
        clientId,
        message,
        conversationId,
        'tool.cancel',
        payload,
        this.cancelToolOperation,
        childCancellation?.executionViewSpec
      );
      return;
    }
  }

  private async executeResolvedInteraction(
    clientId: BridgeClientId,
    message: ReliableExplicitInteractionMessage,
    conversationId: ConversationId,
    input: {
      request: Awaited<ReturnType<ConversationCommandGateway['loadCommittedFacts']>>['interactionRequests'][number];
      ownerTurnId: RunId;
      sourceToolCallId?: ToolCallId;
      interactionRevision: number;
      decision: ResolveInteractionCommandPayload['decision'];
      response: JsonValue;
    }
  ): Promise<void> {
    const sourceKey = `internal:webview:${message.id}`;
    const completedAt = Date.now();
    let patch: ResolveInteractionCommandPayload['patch'];
    if (input.request.kind === 'patch_approval' && input.decision === 'accept') {
      if (!input.sourceToolCallId) throw new Error(`Patch Interaction ${input.request.id} 缺少 ToolCall owner。`);
      const facts = await this.loadCommittedFacts(conversationId);
      const hydrated = await hydrateFileChangeResolutionPayload(fileChangeResolutionPayload({
        conversationId,
        toolCallId: input.sourceToolCallId,
        interactionRequestId: input.request.id,
        interactionRevision: input.interactionRevision,
        decision: 'accept',
        actor: 'user',
        actorId: clientId,
        commandId: message.id,
        completedAt
      }), facts, this.options.storage);
      if (!hydrated.proposalArtifactId || !hydrated.proposalContentHash || hydrated.proposal === undefined) {
        throw new Error(`Patch Interaction ${input.request.id} 无法取得不可变 proposal attestation。`);
      }
      patch = {
        proposalArtifactId: hydrated.proposalArtifactId,
        proposalContentHash: hydrated.proposalContentHash,
        proposal: cloneJson(hydrated.proposal)
      };
    }
    const ids = interactionResolutionIds(input.request.id, input.interactionRevision);
    const payload: ResolveInteractionCommandPayload = {
      conversationId,
      interactionRequestId: input.request.id,
      interactionRevision: input.interactionRevision,
      ownerTurnId: input.ownerTurnId,
      responseId: ids.responseId,
      decision: input.decision,
      actor: 'user',
      actorId: clientId,
      commandId: message.id,
      response: cloneJson(input.response),
      completedAt,
      ...ids.execution,
      ...ids.continuation,
      ...(patch ? { patch } : {})
    };
    await this.commitInteraction(
      clientId,
      message,
      conversationId,
      'interaction.resolve',
      cloneJson(payload),
      this.resolveInteraction
    );
  }


  private async loadCommittedFacts(conversationId: ConversationId) {
    const view = await this.options.backend.readCommittedView(committedReadView('gateway.read', conversationId));
    return view.facts;
  }

  private async resolveForegroundToolChildCancellation(conversationId: ConversationId, toolCallId: ToolCallId): Promise<{
    ownedChild: NonNullable<CancelToolOperationPayload['ownedChild']>;
    executionViewSpec: ReturnType<typeof fullView>;
  } | undefined> {
    const sourceFacts = await this.loadCommittedFacts(conversationId);
    const resolved = resolveForegroundChildToolOwnership(sourceFacts, conversationId, toolCallId);
    if (resolved.status !== 'matched') return undefined;

    const closure = await this.options.adapter.resolveRunGraphClosure(
      resolved.ownership.targetConversationId,
      [resolved.ownership.childRunId],
      runGraphCascadeForPolicy('foreground_child_tool').cascadeBackgroundChildren,
      this.runtimeReadAccess()
    );
    const conversations = [...new Set<ConversationId>([conversationId, ...closure.conversationIds])].sort();
    for (const scope of conversations) {
      if (!this.managed.has(scope)) throw new Error(`ChildRun cancellation scope is not reliability-owned: ${scope}`);
    }
    const base = fullView('tool.cancel', conversationId);
    return {
      ownedChild: {
        bridgeId: resolved.ownership.bridge.id,
        ownerGeneration: resolved.ownership.bridge.ownerGeneration,
        childRunId: resolved.ownership.childRunId,
        targetConversationId: resolved.ownership.targetConversationId,
        closureRunIds: closure.nodes.map((node) => node.runId)
      },
      executionViewSpec: {
        ...base,
        conversations,
        timeline: conversations.map((scope) => ({ conversationId: scope, throughTail: true })),
        closedRunGraphRoots: [resolved.ownership.childRunId],
        closedRunGraphModes: ['foreground', 'background'],
        storageResourceKeys: [ANSWER_BRIDGE_RESOURCE_KEY, CONVERSATION_ATTACHMENTS_RESOURCE_KEY],
        mergeConversationFacts: true,
        aggregateRootConversationId: conversationId
      }
    };
  }

  private readAnswerBridgeLookup() {
    return this.options.backend.readStorageResource(
      [ANSWER_BRIDGE_RESOURCE_KEY],
      () => this.options.adapter.readAnswerBridgeLookup()
    );
  }

  private runtimeReadAccess() {
    return {
      loadFacts: (conversationId: ConversationId) => this.loadCommittedFacts(conversationId),
      readAnswerBridgeLookup: () => this.readAnswerBridgeLookup()
    };
  }

  private async commitInteraction(
    clientId: BridgeClientId,
    message: ReliableOutcomeMessage,
    conversationId: ConversationId,
    type: string,
    payload: JsonValue,
    handler: Parameters<FileConversationTransactionBackend['executeInternal']>[0]['handler'],
    executionViewSpec?: ReturnType<typeof fullView>
  ): Promise<void> {
    const sourceKey = `internal:webview:${message.id}`;
    const committed = await this.options.backend.executeInternal({
      command: {
        sourceKey,
        type,
        scope: { kind: 'conversation', id: conversationId },
        occurredAt: Date.now(),
        payload
      },
      handler: handler as never,
      ...(executionViewSpec ? { executionViewSpec } : {}),
      createPlanningContext: ({ transitionId, now }) => ({ transitionId, now, policySnapshot: null, ids: {} })
    });
    this.postInternalPatches(committed.patches, committed.heads, sourceKey);
    if (committed.status === 'committed' || committed.status === 'already_applied') {
      this.options.onCommitted?.(committed.heads.map((head) => head.conversationId));
    }
    this.postInteractionOutcome(clientId, message, conversationId, committed);
  }

  private postInteractionOutcome(
    clientId: BridgeClientId,
    message: ReliableOutcomeMessage,
    conversationId: ConversationId,
    outcome: {
      transitionId: string;
      status: 'committed' | 'already_applied' | 'stale' | 'already_satisfied';
      heads: readonly CommittedConversationHead[];
      patches: readonly PlannedPatchBatch[];
      result: JsonValue;
    }
  ): void {
    const publicStatus = outcome.status === 'already_satisfied' && internalResultStatus(outcome.result) === 'already_resolved'
      ? 'already_resolved' as const
      : outcome.status;
    const projectionHeads = outcome.patches.map((patch) => {
      const head = outcome.heads.find((candidate) => candidate.conversationId === patch.conversationId);
      if (!head) throw new Error(`Interaction patch has no committed control HEAD: ${patch.conversationId}`);
      return {
        conversationId: head.conversationId,
        version: head.version,
        streamId: patch.streamId,
        patchNextSeq: patch.nextSeq
      };
    });
    this.options.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.InteractionResult,
      channel: 'command',
      correlationId: message.id,
      payload: {
        requestType: message.type,
        conversationId,
        targetId: interactionTargetId(message),
        status: publicStatus,
        transitionId: outcome.transitionId,
        controlHeads: outcome.heads.map((head) => ({ ...head })),
        projectionHeads,
        result: cloneJson(outcome.result),
        ...(outcome.status === 'stale'
          ? { reason: internalResultReason(outcome.result) ?? 'interaction_state_stale' }
          : publicStatus === 'already_resolved'
            ? { reason: 'already_resolved' }
            : outcome.status === 'already_satisfied'
              ? { reason: internalResultReason(outcome.result) ?? 'already_satisfied' }
              : {})
      }
    });
  }

  private postInteractionFailure(
    clientId: BridgeClientId,
    message: ReliableOutcomeMessage,
    conversationId: ConversationId,
    error: unknown
  ): void {
    const reason = error instanceof Error ? error.message : String(error);
    const status = error instanceof PreparedTransitionPendingError || error instanceof SourceClaimRecoveryRequiredError
      ? 'outcome_unknown' as const
      : error instanceof DurableFactsIntegrityError || error instanceof FileTransactionIntegrityError
        ? 'blocked' as const
        : 'rejected' as const;
    this.options.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.InteractionResult,
      channel: 'command',
      correlationId: message.id,
      payload: {
        requestType: message.type,
        conversationId,
        targetId: interactionTargetId(message),
        status,
        reason
      }
    });
    this.postError(clientId, message.id, message.type, reason);
  }

  private postInternalPatches(
    patches: readonly PlannedPatchBatch[],
    heads: readonly import('../../shared/conversationReliability').CommittedConversationHead[],
    sourceKey: string
  ): void {
    for (const patch of patches) {
      const head = heads.find((candidate) => candidate.conversationId === patch.conversationId);
      if (!head) continue;
      this.options.webview.broadcastToStream(patch.streamId, {
        id: createMessageId(),
        type: BridgeMessageType.ConversationCommittedPatch,
        channel: 'state',
        scope: { kind: 'conversation', id: patch.conversationId },
        payload: {
          conversationId: patch.conversationId,
          streamId: patch.streamId,
          baseSeq: patch.baseSeq,
          nextSeq: patch.nextSeq,
          conversationVersion: head.version,
          commandIds: [],
          causes: [{ kind: 'callback', id: sourceKey }],
          ...(patch.terminalStreamFences?.length ? { terminalStreamFences: patch.terminalStreamFences.map((fence) => ({ ...fence })) } : {}),
          operations: [...patch.operations]
        }
      });
    }
  }

  private async ensureManaged(conversationId: ConversationId): Promise<void> {
    if (this.managed.has(conversationId)) return;
    const current = this.managing.get(conversationId);
    if (current) return current;
    const promise = this.manage(conversationId).finally(() => this.managing.delete(conversationId));
    this.managing.set(conversationId, promise);
    return promise;
  }

  private async prepareCommittedConversation(conversationId: ConversationId, required: boolean): Promise<void> {
    const runtime = await this.options.adapter.readRuntime(conversationId);
    if (!runtime) {
      if (required) throw new Error(`Conversation has no committed runtime authority: ${conversationId}`);
      return;
    }
    await this.publishManagedConversation(conversationId);
  }

  private async manage(conversationId: ConversationId): Promise<void> {
    await this.prepareCommittedConversation(conversationId, true);
  }

  private async publishManagedConversation(conversationId: ConversationId): Promise<void> {
    this.managed.add(conversationId);
    await this.options.installCommittedHead?.(await this.options.backend.conversationHead(conversationId));
  }

  private finishHostCommand(result: Awaited<ReturnType<FileConversationTransactionBackend['execute']>>): boolean {
    this.postCommittedPatches(result.patches, result.ack);
    if (result.ack.status === 'rejected') return false;
    this.options.onCommitted?.(result.ack.controlHeads.map((head) => head.conversationId));
    return true;
  }

  private postCommittedPatches(patches: readonly PlannedPatchBatch[], ack: CommandAck): void {
    if (ack.status === 'rejected') return;
    for (const patch of patches) {
      const head = ack.projectionHeads.find((candidate) => candidate.conversationId === patch.conversationId);
      if (!head) continue;
      this.options.webview.broadcastToStream(patch.streamId, {
        id: createMessageId(),
        type: BridgeMessageType.ConversationCommittedPatch,
        channel: 'state',
        scope: { kind: 'conversation', id: patch.conversationId },
        payload: {
          conversationId: patch.conversationId,
          streamId: patch.streamId,
          baseSeq: patch.baseSeq,
          nextSeq: patch.nextSeq,
          conversationVersion: head.version,
          commandIds: [ack.commandId],
          ...(patch.terminalStreamFences?.length ? { terminalStreamFences: patch.terminalStreamFences.map((fence) => ({ ...fence })) } : {}),
          operations: [...patch.operations]
        }
      });
    }
  }

  private async postStatus(clientId: BridgeClientId, commandId: CommandId, correlationId: string): Promise<void> {
    const result = await this.options.backend.status(commandId);
    this.options.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.CommandStatusResult,
      channel: 'command',
      correlationId,
      payload: { commandId, result }
    });
  }

  private postServiceFailure(clientId: BridgeClientId, message: ReliableBridgeMessage, error: unknown): void {
    const commandId = message.payload?.command.commandId as CommandId;
    this.options.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.CommandResult,
      channel: 'command',
      correlationId: message.id,
      payload: { error: commandServiceError(commandId, error) }
    });
  }

  private postStatusFailure(clientId: BridgeClientId, commandId: CommandId, correlationId: string, error: unknown): void {
    this.options.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.CommandStatusResult,
      channel: 'command',
      correlationId,
      payload: {
        commandId,
        result: { status: 'blocked', error: commandServiceError(commandId, error) }
      }
    });
  }

  private postError(clientId: BridgeClientId, correlationId: string, requestType: string, message: string): void {
    this.options.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.Error,
      channel: 'diagnostics',
      correlationId,
      payload: { requestType, message }
    });
  }
}

function commandServiceError(commandId: CommandId, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const code = error instanceof DurableCommandFailureError
    ? error.serviceCode
    : error instanceof PreparedTransitionPendingError || error instanceof SourceClaimRecoveryRequiredError || error instanceof ConversationCommandDeadlineError
      ? 'recovery_required' as const
      : error instanceof FileTransactionIntegrityError || error instanceof DurableFactsIntegrityError
        ? 'integrity_violation' as const
        : errorCode === 'migration_required'
          ? 'migration_required' as const
          : errorCode === 'scheduler_compile_failed'
            ? 'runtime_unavailable' as const
            : 'storage_unavailable' as const;
  return {
    commandId,
    status: 'unavailable' as const,
    code,
    message,
    ...(error instanceof DurableCommandFailureError ? { durable: true } : {})
  };
}

function commandEnvelope(message: ReliableBridgeMessage): Omit<CommandEnvelope<JsonValue>, 'type' | 'payload'> {
  const payload = message.payload!;
  return {
    commandId: payload.command.commandId as CommandId,
    scope: { kind: 'conversation', id: payload.conversationId as ConversationId },
    expectedVersions: [{ conversationId: payload.conversationId as ConversationId, version: payload.command.expectedVersion }],
    issuedAt: payload.command.issuedAt
  };
}

function interactionTargetId(message: ReliableOutcomeMessage): string {
  const payload = message.payload as { interactionRequestId?: unknown; toolCallId?: unknown } | undefined;
  if (typeof payload?.interactionRequestId === 'string') return payload.interactionRequestId;
  if (typeof payload?.toolCallId === 'string') return payload.toolCallId;
  return message.id;
}

function sameStringIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function hostTurnInterruptResult(ack: CommandAck<JsonValue>, frozenTurnId: RunId): HostTurnInterruptResult {
  if (ack.status === 'rejected') {
    return {
      status: 'stale',
      turnId: frozenTurnId,
      reason: `${ack.code}: ${ack.message}`
    };
  }
  const resultStatus = internalResultStatus(ack.result);
  const base = { turnId: frozenTurnId, transitionId: ack.transitionId } as const;
  if (resultStatus === 'interrupt_committed') return { ...base, status: ack.status };
  if (resultStatus === 'already_terminal') return { ...base, status: 'already_satisfied', reason: 'target_turn_already_terminal' };
  if (resultStatus === 'target_replaced') return { ...base, status: 'stale', reason: 'target_replaced' };
  throw new FileTransactionIntegrityError(`Turn interrupt returned an unknown outcome for frozen Turn ${frozenTurnId}: ${String(resultStatus)}`);
}

function internalResultStatus(result: JsonValue): string | undefined {
  if (!result || Array.isArray(result) || typeof result !== 'object') return undefined;
  return typeof result.status === 'string' ? result.status : undefined;
}

function internalResultReason(result: JsonValue): string | undefined {
  if (!result || Array.isArray(result) || typeof result !== 'object') return undefined;
  const reason = result.reason;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;
}

function normalizeUserContent(content: MessageContent | undefined, text: string | undefined): MessageContent {
  if (content?.parts?.length) return { role: 'user', parts: JSON.parse(JSON.stringify(content.parts)) };
  const normalized = text?.trim() ?? '';
  if (!normalized) throw new Error('User message content cannot be empty.');
  return { role: 'user', parts: [{ text: normalized }] };
}

function isReliableCommandType(type: string): boolean {
  return type === BridgeMessageType.TurnStart
    || type === BridgeMessageType.TurnEnqueue
    || type === BridgeMessageType.TurnSteer
    || type === BridgeMessageType.TurnInterrupt
    || type === BridgeMessageType.TurnIntentUpdate
    || type === BridgeMessageType.TurnIntentCancel
    || type === BridgeMessageType.TurnIntentReorder
    || type === BridgeMessageType.TurnIntentPause
    || type === BridgeMessageType.TurnIntentResume
    || type === BridgeMessageType.TurnIntentResumeAll
    || type === BridgeMessageType.TurnIntentPromote
    || type === BridgeMessageType.MessageEdit
    || type === BridgeMessageType.MessageDeleteFrom
    || type === BridgeMessageType.MessageRetryFrom
    || type === BridgeMessageType.CommandOutcomeResolve;
}

function isReliableCommandMessage(message: WebviewToExtensionMessage): message is ReliableBridgeMessage {
  return isReliableCommandType(message.type);
}

function cancellationPolicyForCommand(message: ReliableBridgeMessage): CancellationPolicyName {
  if (message.type === BridgeMessageType.TurnInterrupt) {
    return message.payload?.cascadeChildAgents === true ? 'full_tree_stop' : 'conversation_stop';
  }
  return 'run_replacement';
}

function commandNeedsClosedRunGraph(message: ReliableBridgeMessage): boolean {
  return message.type === BridgeMessageType.TurnInterrupt
    || message.type === BridgeMessageType.TurnIntentPromote
    || message.type === BridgeMessageType.MessageDeleteFrom
    || message.type === BridgeMessageType.MessageRetryFrom
    || (message.type === BridgeMessageType.MessageEdit && (message.payload?.deleteFollowing === true || message.payload?.runAfterEdit === true));
}

function isReliableToolControlMessage(message: WebviewToExtensionMessage): message is ReliableToolControlMessage {
  return message.type === BridgeMessageType.ToolExecutionCancel;
}

function isReliableInteractionMessage(message: WebviewToExtensionMessage): message is ReliableInteractionMessage {
  return message.type === BridgeMessageType.InteractionResolve
    || isReliableToolControlMessage(message);
}

function isReliableMaintenanceMessage(message: WebviewToExtensionMessage): message is ReliableMaintenanceMessage {
  return message.type === BridgeMessageType.CheckpointDismiss
    || message.type === BridgeMessageType.CompressionCreate
    || message.type === BridgeMessageType.CompressionDelete
    || message.type === BridgeMessageType.CompressionUpdate
    || message.type === BridgeMessageType.CompressionRegenerate
    || message.type === BridgeMessageType.CompressionDisable
    || message.type === BridgeMessageType.CompressionEnable;
}

function interactionConversationId(
  message: ReliableInteractionMessage,
  resolveToolConversationId: ((toolCallId: string) => string | undefined) | undefined
): string | undefined {
  const payload = message.payload as { conversationId?: unknown; toolCallId?: unknown };
  const explicit = typeof payload.conversationId === 'string' ? payload.conversationId.trim() : '';
  const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
  return explicit || (toolCallId ? resolveToolConversationId?.(toolCallId)?.trim() : undefined) || undefined;
}

function controlContinuationIds(sourceKey: string) {
  return {
    toolCallEventId: stableIdFromSeed('toolCallEvent', `${sourceKey}:tool-event`),
    responseMessageId: stableIdFromSeed('message', `${sourceKey}:response-message`),
    responseRevisionId: stableIdFromSeed('messageRevision', `${sourceKey}:response-revision`),
    nextInvocationId: stableIdFromSeed('invocation', `${sourceKey}:next-invocation`),
    nextRequestId: stableIdFromSeed('request', `${sourceKey}:next-request`),
    nextOperationId: stableIdFromSeed('operation', `${sourceKey}:next-operation`),
    nextAttemptId: stableIdFromSeed('attempt', `${sourceKey}:next-attempt`),
    nextEffectIntentId: stableIdFromSeed('effectIntent', `${sourceKey}:next-effect`)
  };
}

function cloneAuthority(value: EffectiveTurnAuthority): EffectiveTurnAuthority {
  return JSON.parse(JSON.stringify(value)) as EffectiveTurnAuthority;
}

function cloneJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
