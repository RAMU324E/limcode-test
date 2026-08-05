import { createHash } from 'node:crypto';
import type { MessageContent } from '../../shared/protocol';
import type { RuntimeDeliveryControlPlane } from './answerDelivery';
import { AutomaticRuntimeDeliveryRouter } from './automaticRuntimeDelivery';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { ContextSequenceControlPlane } from './contextSequence';
import {
  EffectControlPlane,
  type FrozenToolCallPolicyDecision,
  type ToolOutcomeStatus,
  type ToolTerminalResult
} from './effectControlPlane';
import {
  ModelProviderControlPlane,
  modelRequestIdFor,
  type FullRequestProviderAdapter,
  type ProviderStreamEvent,
  type StreamEventResult
} from './modelProviderControlPlane';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  isTurnTerminalInputConflictError,
  TurnControlPlane,
  type TurnInputCommand
} from './turnControlPlane';
import { assistantMessageIdFor, TurnOutputControlPlane } from './turnOutput';
import { ExecutionHandoffError, isExecutionHandoffError } from './executionLeaseFence';
import type {
  CoordinateCompressionCommand,
  CoordinateCompressionResult
} from './contextCompressionCoordinator';

export interface ReliableAgentToolDefinition {
  name: string;
  description: string;
  parameters: PlainJsonValue;
  /** Credential-free source identity used for frozen dynamic MCP policy evaluation. */
  source?: PlainJsonValue;
  /** Plain definition facts frozen into the ModelRequest recipe. */
  metadata?: PlainJsonValue;
  defaultConfig?: PlainJsonValue;
}

export interface ReliableAgentProviderRegistry {
  resolve(providerId: string): Promise<FullRequestProviderAdapter> | FullRequestProviderAdapter;
  dispose?(): Promise<void> | void;
}

export interface ReliableAgentCompressionCoordinator {
  coordinate(command: CoordinateCompressionCommand): Promise<CoordinateCompressionResult>;
}

export interface ReliableAgentToolDispatchInput {
  turnId: string;
  modelRequestId: string;
  toolCallId: string;
  providerCallId?: string;
  toolName: string;
  arguments: PlainJsonValue;
}

export interface ReliableAgentToolPause {
  disposition: 'paused';
  toolCallId: string;
  reason: 'awaiting_user' | 'awaiting_approval' | 'awaiting_plan_review' | 'awaiting_child' | 'background_process';
  resumeKey?: string;
}

export interface ReliableAgentToolSettled {
  disposition: 'settled';
  toolCallId: string;
  status: ToolOutcomeStatus;
}

/** Dispatcher owns capability-specific EffectIntent/Receipt semantics and may durably pause the Turn. */
export interface ReliableAgentToolDispatcher {
  /** turnId selects definitions through that Turn's immutable authority snapshot. */
  definitions(turnId?: string): Promise<ReliableAgentToolDefinition[]> | ReliableAgentToolDefinition[];
  /** Compiles display/gate/scheduling for a Provider batch from one immutable authority read. */
  freezeCalls?(inputs: ReadonlyArray<ReliableAgentToolDispatchInput & {
    definition: ReliableAgentToolDefinition;
  }>): Promise<FrozenToolCallPolicyDecision[]>;
  /** Compiles display/gate/scheduling from the immutable Turn authority and frozen recipe definition. */
  freezeCall?(input: ReliableAgentToolDispatchInput & {
    definition: ReliableAgentToolDefinition;
  }): Promise<FrozenToolCallPolicyDecision>;
  /** Dispatches one already-frozen parallel group while sharing read-only preflight/finalization work. */
  dispatchBatch?(inputs: readonly ReliableAgentToolDispatchInput[]): Promise<Array<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>>;
  dispatch(input: ReliableAgentToolDispatchInput): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>;
  /** Prewired cancellation boundary; Runner may invoke it without knowing capability internals. */
  cancelActive?(input: { turnId: string; reason: string }): Promise<void> | void;
  /** Host handoff aborts local waits without inventing a user cancellation or terminal Turn. */
  quiesceTurn?(input: { turnId: string; reason: ExecutionHandoffError }): Promise<void> | void;
  quiesce?(reason: ExecutionHandoffError): Promise<void> | void;
  /** Closes capability-specific durable waits before a terminal Turn asserts every ToolCall is terminal. */
  cancelWaiting?(input: { turnId: string; sourceKey: string; reason: string }): Promise<void>;
  dispose?(): Promise<void> | void;
}

export interface ReliableAgentTransientEvent {
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  requestSeq: string;
  providerId: string;
  modelId: string;
  attemptSeq: string;
  socketGeneration: string;
  /** Durable commit frontier visible before this Provider socket was dispatched. */
  afterCommitSeq: string;
  event: ProviderStreamEvent;
  observedAt: string;
}

export interface ReliableAgentTransientObserver {
  observe(event: ReliableAgentTransientEvent): void;
}

export type ReliableAgentLifecycleStage =
  | 'drive_started'
  | 'round_facts_ready'
  | 'provider_dispatch_started'
  | 'provider_output_ready'
  | 'assistant_commit_started'
  | 'assistant_commit_completed'
  | 'tool_dispatch_started'
  | 'tool_dispatch_completed'
  | 'turn_terminal_started'
  | 'turn_terminal_completed'
  | 'drive_failed'
  | 'failure_terminal_started'
  | 'failure_terminal_completed'
  | 'failure_terminal_failed';

/** Bounded metadata-only diagnostics. No prompt, model output, tool arguments, or credentials are exposed. */
export interface ReliableAgentLifecycleEvent {
  turnId: string;
  stage: ReliableAgentLifecycleStage;
  observedAt: string;
  /** Durable ModelRequest sequence. Decimal string because runtime sequences must not cross JS number. */
  round?: string;
  modelRequestId?: string;
  toolCallId?: string;
  /** Present when one dispatcher call owns a Provider parallel group. */
  toolBatchSize?: number;
  schedulingMode?: 'parallel' | 'serial';
  errorName?: string;
  errorMessage?: string;
}

export interface ReliableAgentLifecycleObserver {
  observe(event: ReliableAgentLifecycleEvent): void;
}

export interface ReliableAgentLoopResult {
  turnId: string;
  terminalStatus: 'completed' | 'failed' | 'interrupted' | 'waiting';
  modelRequestIds: string[];
  assistantMessageIds: string[];
  toolCallIds: string[];
  waitingToolCallId?: string;
}

interface NormalizedToolCall {
  providerCallId?: string;
  providerOrdinal: number;
  name: string;
  arguments: PlainJsonValue;
  thoughtSignature?: string;
}

interface NormalizedProviderOutput {
  text: string;
  thought: string;
  thoughtSignature?: string;
  thoughtDurationMs?: number;
  toolCalls: NormalizedToolCall[];
  usage?: PlainJsonValue;
}

interface FrozenProviderToolCall extends NormalizedToolCall {
  toolCallId: string;
  policy: FrozenToolCallPolicyDecision;
}

const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';

/**
 * 单 Turn 的可靠 Agent loop。每轮都冻结 Context root/authority，Provider 完成摘要先落 SQLite/CAS，
 * 再幂等提交 assistant Message；工具结果按 call_seq 持久化并追加 Context tool_pair。
 */
export class ReliableAgentLoop {
  private readonly context: ContextSequenceControlPlane;
  private readonly automaticDeliveries: AutomaticRuntimeDeliveryRouter;
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly turns: TurnControlPlane,
    private readonly turnOutput: TurnOutputControlPlane,
    private readonly modelProvider: ModelProviderControlPlane,
    private readonly effects: EffectControlPlane,
    private readonly runtimeDeliveries: RuntimeDeliveryControlPlane,
    private readonly providers: ReliableAgentProviderRegistry,
    private readonly compressionCoordinator: ReliableAgentCompressionCoordinator,
    private readonly tools: ReliableAgentToolDispatcher,
    private readonly transientObserver?: ReliableAgentTransientObserver,
    private readonly lifecycleObserver?: ReliableAgentLifecycleObserver,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
    this.automaticDeliveries = new AutomaticRuntimeDeliveryRouter(database);
  }

  public async runInput(command: TurnInputCommand): Promise<ReliableAgentLoopResult> {
    const started = await this.turns.input(command);
    const turnId = requireId(started.turnId, 'Turn input result.turnId');
    return this.drive(turnId);
  }

  /** Safe for explicit recovery/re-entry; every round and output identity is deterministic. */
  public async drive(turnIdInput: string): Promise<ReliableAgentLoopResult> {
    const turnId = requireId(turnIdInput, 'turnId');
    const modelRequestIds: string[] = [];
    const assistantMessageIds: string[] = [];
    const toolCallIds: string[] = [];
    this.observeLifecycle({ turnId, stage: 'drive_started' });

    try {
      // ModelRequest.request_seq is the durable loop frontier. A re-entry deliberately starts at
      // the last committed request so a crash between Provider completion, assistant commit, tool
      // settlement and Context append replays that one round idempotently. Only after the replayed
      // round is complete do we advance to request_seq + 1. There is no process-local round cap:
      // safety limits belong to explicit token/cost/time policy, never an invisible failed Turn.
      let requestSequence = await this.resumeRequestSequence(turnId);
      agentRounds: for (;;) {
        const round = requestSequence.toString();
        let facts = await this.readRoundFacts(turnId);
        await this.cancelSupersededCompressionRequests(
          turnId,
          requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id')
        );
        this.observeLifecycle({ turnId, stage: 'round_facts_ready', round });
        if (facts.turn.status !== 'active') {
          return {
            turnId,
            terminalStatus: await this.readLoopTerminalStatus(turnId, facts.turn),
            modelRequestIds,
            assistantMessageIds,
            toolCallIds
          };
        }
        if (await this.terminateIfRequested(turnId, `round:${round}:before-model-request`)) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        const idempotencyKey = `agent-loop:${turnId}:round:${round}`;
        const expectedModelRequestId = modelRequestIdFor(turnId, idempotencyKey);
        let request = await this.maybeGet('ModelRequest', expectedModelRequestId);
        if (!request) {
          // Runtime input is admitted only at a new request boundary. On recovery an existing
          // request may still be waiting for its tool results; inserting runtime_context before
          // those results would split the atomic assistant-tool/result pair.
          if (await this.absorbRuntimeDeliveryInputs(turnId) > 0) {
            facts = await this.readRoundFacts(turnId);
          }
          const compression = await this.compressionCoordinator.coordinate({
            turnId,
            authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
            headRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
            trigger: 'auto'
          });
          if (compression.status === 'compressed') facts = await this.readRoundFacts(turnId);
          const toolDefinitions = await this.tools.definitions(turnId);
          const created = await this.modelProvider.createModelRequest({
            turnId,
            contextRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
            authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
            recipe: normalizePlainJson({
              kind: 'reliable-agent-turn',
              round,
              tools: toolDefinitions
            }, 'Reliable Agent recipe'),
            idempotencyKey
          });
          if (created.modelRequestId !== expectedModelRequestId) {
            throw new Error('ModelProvider returned an unexpected stable ModelRequest identity.');
          }
          request = await this.requireExisting('ModelRequest', expectedModelRequestId);
        }
        await this.assertModelRequestRound(request, requestSequence, expectedModelRequestId);
        const modelRequestId = expectedModelRequestId;
        modelRequestIds.push(modelRequestId);
        if (await this.terminateIfRequested(turnId, `round:${round}:model-request:${modelRequestId}`)) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        let output: NormalizedProviderOutput;
        if (request.status === 'terminal') {
          output = await this.readTerminalProviderOutput(modelRequestId);
        } else {
          this.observeLifecycle({ turnId, stage: 'provider_dispatch_started', round, modelRequestId });
          output = await this.dispatchAndCapture(
            requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
            turnId,
            modelRequestId,
            request
          );
        }
        this.observeLifecycle({ turnId, stage: 'provider_output_ready', round, modelRequestId });
        if (await this.terminateIfRequested(turnId, `round:${round}:provider-output:${modelRequestId}`)) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        if (output.toolCalls.length === 0) {
          const fence = await this.automaticDeliveries.establishFinalOutputFence({ turnId, modelRequestId });
          if (!fence.established) {
            if (await this.absorbRuntimeDeliveryInputs(turnId) > 0) {
              requestSequence += 1n;
              continue agentRounds;
            }
            const latestTurn = await this.requireExisting('Turn', turnId);
            if (latestTurn.status !== 'active') {
              return {
                turnId,
                terminalStatus: await this.readLoopTerminalStatus(turnId, latestTurn),
                modelRequestIds,
                assistantMessageIds,
                toolCallIds
              };
            }
            throw new Error(`Turn ${turnId} could not establish final-output authority.`);
          }
          if (await this.terminateIfRequested(turnId, `round:${round}:final-output-fenced:${modelRequestId}`)) {
            return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
          }
        }
        this.observeLifecycle({ turnId, stage: 'assistant_commit_started', round, modelRequestId });
        const message = await this.turnOutput.appendAssistantMessage({
          turnId,
          modelRequestId,
          sourceKey: modelRequestId,
          content: JSON.stringify(providerOutputMessage(output)),
          contentType: MESSAGE_CONTENT_TYPE
        });
        assistantMessageIds.push(message.messageId);
        this.observeLifecycle({ turnId, stage: 'assistant_commit_completed', round, modelRequestId });

        if (output.toolCalls.length === 0) {
          // The final-output fence was committed before this visible Message. Automatic runtime
          // input must now target a new Turn; extending this Turn would rewrite a displayed final.
          for (;;) {
            if (await this.terminateIfRequested(turnId, `round:${round}:before-complete:${modelRequestId}`)) {
              return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
            }
            const terminalFacts = await this.readRoundFacts(turnId);
            await this.compressionCoordinator.coordinate({
              turnId,
              authoritySnapshotId: requireId(terminalFacts.authority.id, 'AuthoritySnapshot.id'),
              headRootId: requireId(terminalFacts.head.root_id, 'ConversationContextHeadLink.root_id'),
              trigger: 'auto'
            });
            this.observeLifecycle({ turnId, stage: 'turn_terminal_started', round, modelRequestId });
            try {
              await this.turns.terminal({
                source: { kind: 'internal', key: `agent-loop:${turnId}:complete:${modelRequestId}` },
                turnId,
                terminalStatus: 'completed',
                reason: 'model_completed_without_tool_calls'
              });
            } catch (error) {
              if (isTurnTerminalInputConflictError(error)) {
                if (await this.terminateIfRequested(turnId, `round:${round}:final-output-fenced:${modelRequestId}`)) {
                  return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
                }
                throw new Error(
                  `Runtime input crossed final-output fence for Turn ${turnId}: ${errorMessage(error)}`
                );
              }
              throw error;
            }
            this.observeLifecycle({ turnId, stage: 'turn_terminal_completed', round, modelRequestId });
            const terminalTurn = await this.requireExisting('Turn', turnId);
            return {
              turnId,
              terminalStatus: await this.readLoopTerminalStatus(turnId, terminalTurn),
              modelRequestIds,
              assistantMessageIds,
              toolCallIds
            };
          }
        }

        const batch = await this.prepareProviderToolBatch({
          turnId,
          modelRequestId,
          messageId: message.messageId,
          output
        });
        toolCallIds.push(...batch.map((call) => call.toolCallId));
        if (await this.terminateIfRequested(
          turnId,
          `round:${round}:created-tool-batch`,
          batch[0]?.toolCallId
        )) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        const batchDispatch = await this.dispatchProviderToolBatch({
          conversationId: requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
          turnId,
          round,
          modelRequestId,
          calls: batch
        });
        if (batchDispatch.status === 'interrupted') {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        if (batchDispatch.status === 'waiting') {
          return {
            turnId,
            terminalStatus: 'waiting',
            modelRequestIds,
            assistantMessageIds,
            toolCallIds,
            waitingToolCallId: batchDispatch.toolCallId
          };
        }
        requestSequence += 1n;
      }
    } catch (error) {
      // Host shutdown / lease replacement is a recoverable transport handoff. Recording a failed
      // Turn here would destroy the exact durable frontier the next Host needs to resume.
      if (isExecutionHandoffError(error)) throw error;
      let interruptionCheckError: unknown;
      try {
        if (await this.terminateIfRequested(turnId, 'drive-interrupted')) {
          const terminalTurn = await this.requireExisting('Turn', turnId);
          return {
            turnId,
            terminalStatus: await this.readLoopTerminalStatus(turnId, terminalTurn),
            modelRequestIds,
            assistantMessageIds,
            toolCallIds
          };
        }
      } catch (checkError) {
        interruptionCheckError = checkError;
      }
      // A durable interrupt wins over the transport AbortError that it deliberately caused. Only a
      // genuine unrequested failure is allowed to enter the drive_failed terminal path.
      this.observeLifecycle({ turnId, stage: 'drive_failed', ...errorDiagnostic(error) });
      try {
        if (interruptionCheckError !== undefined) throw interruptionCheckError;
        this.observeLifecycle({ turnId, stage: 'failure_terminal_started' });
        if (!await this.terminateIfRequested(turnId, 'drive-failed')) {
          await this.failActiveTurn(turnId, error);
        }
        this.observeLifecycle({ turnId, stage: 'failure_terminal_completed' });
      } catch (terminalError) {
        this.observeLifecycle({ turnId, stage: 'failure_terminal_failed', ...errorDiagnostic(terminalError) });
        const combined = new Error(`Reliable Agent Turn ${turnId} failed and could not record terminal state.`) as Error & {
          originalError?: unknown;
          terminalError?: unknown;
        };
        combined.originalError = error;
        combined.terminalError = terminalError;
        throw combined;
      }
      const terminalTurn = await this.requireExisting('Turn', turnId);
      return {
        turnId,
        terminalStatus: await this.readLoopTerminalStatus(turnId, terminalTurn),
        modelRequestIds,
        assistantMessageIds,
        toolCallIds
      };
    }
  }

  private async prepareProviderToolBatch(input: {
    turnId: string;
    modelRequestId: string;
    messageId: string;
    output: NormalizedProviderOutput;
  }): Promise<FrozenProviderToolCall[]> {
    const definitions = await this.readModelRequestToolDefinitions(input.modelRequestId);
    const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
    const existingLinks = await listAllDomainRows(
      this.database,
      'ToolCallSourceLink',
      { model_request_id: input.modelRequestId }
    );
    if (existingLinks.length !== 0 && existingLinks.length !== input.output.toolCalls.length) {
      throw new Error(`ModelRequest ${input.modelRequestId} has an incomplete durable ToolCall batch.`);
    }
    const existingByOrdinal = new Map(existingLinks.map((link) => [
      requireNonNegativeSafeNumber(link.provider_ordinal, 'ToolCallSourceLink.provider_ordinal'),
      link
    ]));
    const calls: Array<FrozenProviderToolCall | undefined> = new Array(input.output.toolCalls.length);
    const pending: Array<{
      index: number;
      call: NormalizedProviderOutput['toolCalls'][number];
      toolCallId: string;
      dispatchInput: ReliableAgentToolDispatchInput & { definition: ReliableAgentToolDefinition };
    }> = [];
    for (let index = 0; index < input.output.toolCalls.length; index += 1) {
      const call = input.output.toolCalls[index];
      const toolCallId = providerToolCallId(input.modelRequestId, call);
      const existingLink = existingByOrdinal.get(call.providerOrdinal);
      if (existingLink) {
        if (
          existingLink.tool_call_id !== toolCallId
          || existingLink.message_id !== input.messageId
          || existingLink.provider_call_id !== (call.providerCallId ?? null)
          || existingLink.thought_signature !== (call.thoughtSignature ?? null)
        ) throw new Error(`Provider ToolCall source replay conflicts at ordinal ${call.providerOrdinal}.`);
        const rows = await this.list('ToolCallPolicySnapshot', { tool_call_id: toolCallId }, 2);
        if (rows.length !== 1) throw new Error(`ToolCall ${toolCallId} must have one frozen policy snapshot.`);
        calls[index] = { ...call, toolCallId, policy: frozenPolicyFromRow(rows[0]) };
        continue;
      }
      const definition = definitionsByName.get(call.name) ?? unknownToolDefinition(call.name);
      pending.push({
        index,
        call,
        toolCallId,
        dispatchInput: {
          turnId: input.turnId,
          modelRequestId: input.modelRequestId,
          toolCallId,
          ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
          toolName: call.name,
          arguments: call.arguments,
          definition
        }
      });
    }
    const pendingPolicies = this.tools.freezeCalls
      ? await this.tools.freezeCalls(pending.map((entry) => entry.dispatchInput))
      : await Promise.all(pending.map((entry) => this.tools.freezeCall
          ? this.tools.freezeCall(entry.dispatchInput)
          : Promise.resolve(fallbackFrozenToolPolicy(entry.dispatchInput.definition, entry.call.arguments))));
    if (pendingPolicies.length !== pending.length) {
      throw new Error('Tool dispatcher freezeCalls result length does not match the Provider batch.');
    }
    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index];
      calls[entry.index] = {
        ...entry.call,
        toolCallId: entry.toolCallId,
        policy: pendingPolicies[index]
      };
    }
    const frozenCalls = calls.map((call, index) => {
      if (!call) throw new Error(`Provider ToolCall ${index} lacks a frozen policy.`);
      return call;
    });
    const batchId = stableId('tool_call_batch', input.modelRequestId);
    await this.effects.createToolCallBatch({
      source: { kind: 'callback', key: `agent-loop:${input.modelRequestId}:tool-batch` },
      batchId,
      turnId: input.turnId,
      modelRequestId: input.modelRequestId,
      messageId: input.messageId,
      entries: frozenCalls.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.name,
        arguments: call.arguments,
        ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
        providerOrdinal: call.providerOrdinal,
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
        policy: call.policy
      }))
    });
    return frozenCalls;
  }

  private async dispatchProviderToolBatch(input: {
    conversationId: string;
    turnId: string;
    round: string;
    modelRequestId: string;
    calls: readonly FrozenProviderToolCall[];
  }): Promise<{ status: 'completed' } | { status: 'waiting' | 'interrupted'; toolCallId: string }> {
    let cursor = 0;
    while (cursor < input.calls.length) {
      const first = input.calls[cursor];
      if (await this.terminateIfRequested(
        input.turnId,
        `round:${input.round}:before-tool-batch:${cursor + 1}`,
        first.toolCallId
      )) return { status: 'interrupted', toolCallId: first.toolCallId };
      let end = cursor + 1;
      if (first.policy.schedulingMode === 'parallel') {
        while (end < input.calls.length && input.calls[end].policy.schedulingMode === 'parallel') end += 1;
      }
      const group = input.calls.slice(cursor, end);
      const batchFinalized = await this.dispatchProviderToolGroup({
        turnId: input.turnId,
        round: input.round,
        modelRequestId: input.modelRequestId,
        calls: group
      });
      if (!batchFinalized) await this.effects.finalizeReadyInOrder(input.turnId);
      await this.appendTerminalToolPairsInOrder(input.conversationId, input.calls);

      if (await this.terminateIfRequested(
        input.turnId,
        `round:${input.round}:after-tool-batch:${end}`,
        group[group.length - 1].toolCallId
      )) return { status: 'interrupted', toolCallId: group[group.length - 1].toolCallId };
      for (const call of group) {
        if (!await this.effects.readTerminalResult(call.toolCallId, false)) {
          return { status: 'waiting', toolCallId: call.toolCallId };
        }
      }
      cursor = end;
    }
    await this.appendTerminalToolPairsInOrder(input.conversationId, input.calls);
    return { status: 'completed' };
  }

  private async dispatchProviderToolGroup(input: {
    turnId: string;
    round: string;
    modelRequestId: string;
    calls: readonly FrozenProviderToolCall[];
  }): Promise<boolean> {
    if (!this.tools.dispatchBatch || input.calls.length <= 1) {
      await Promise.all(input.calls.map((call) => this.dispatchProviderToolCall({
        turnId: input.turnId,
        round: input.round,
        modelRequestId: input.modelRequestId,
        call
      })));
      return false;
    }
    for (const call of input.calls) {
      this.observeLifecycle({
        turnId: input.turnId,
        stage: 'tool_dispatch_started',
        round: input.round,
        modelRequestId: input.modelRequestId,
        toolCallId: call.toolCallId,
        toolBatchSize: input.calls.length,
        schedulingMode: 'parallel'
      });
    }
    const dispatched = await this.tools.dispatchBatch(input.calls.map((call) => ({
      turnId: input.turnId,
      modelRequestId: input.modelRequestId,
      toolCallId: call.toolCallId,
      ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
      toolName: call.name,
      arguments: call.arguments
    })));
    if (dispatched.length !== input.calls.length) {
      throw new Error('Tool dispatcher dispatchBatch result length does not match the parallel group.');
    }
    for (let index = 0; index < dispatched.length; index += 1) {
      if (isToolPause(dispatched[index])) continue;
      this.observeLifecycle({
        turnId: input.turnId,
        stage: 'tool_dispatch_completed',
        round: input.round,
        modelRequestId: input.modelRequestId,
        toolCallId: input.calls[index].toolCallId,
        toolBatchSize: input.calls.length,
        schedulingMode: 'parallel'
      });
    }
    return true;
  }

  private async dispatchProviderToolCall(input: {
    turnId: string;
    round: string;
    modelRequestId: string;
    call: FrozenProviderToolCall;
  }): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    const existing = await this.effects.readTerminalResult(input.call.toolCallId, false);
    if (existing) return existing;
    try {
      this.observeLifecycle({
        turnId: input.turnId,
        stage: 'tool_dispatch_started',
        round: input.round,
        modelRequestId: input.modelRequestId,
        toolCallId: input.call.toolCallId
      });
      const dispatched = await this.tools.dispatch({
        turnId: input.turnId,
        modelRequestId: input.modelRequestId,
        toolCallId: input.call.toolCallId,
        ...(input.call.providerCallId ? { providerCallId: input.call.providerCallId } : {}),
        toolName: input.call.name,
        arguments: input.call.arguments
      });
      if (!isToolPause(dispatched)) {
        this.observeLifecycle({
          turnId: input.turnId,
          stage: 'tool_dispatch_completed',
          round: input.round,
          modelRequestId: input.modelRequestId,
          toolCallId: input.call.toolCallId
        });
      }
      return dispatched;
    } catch (error) {
      // Host handoff is not a tool failure. The durable ToolCall/Effect frontier deliberately
      // remains incomplete so the next lease generation can recover it; materializing a failed
      // ToolOutcome here would both lie to the model and race a still-running detached process.
      if (isExecutionHandoffError(error)) throw error;
      const failed = await this.effects.settleWithoutEffect({
        source: { kind: 'internal', key: `agent-loop:${input.call.toolCallId}:dispatcher-failed` },
        toolCallId: input.call.toolCallId,
        status: 'failed',
        detail: { error: error instanceof Error ? error.message : String(error) }
      });
      return failed.terminal ?? {
        disposition: 'settled',
        toolCallId: input.call.toolCallId,
        status: failed.status
      };
    }
  }

  private async appendTerminalToolPairsInOrder(
    conversationId: string,
    calls: readonly FrozenProviderToolCall[]
  ): Promise<void> {
    for (const call of calls) {
      const terminal = await this.effects.readTerminalResult(call.toolCallId, false);
      if (!terminal) return;
      await this.appendTerminalToolPairOnce({
        conversationId,
        toolCallId: call.toolCallId,
        toolModelResultId: terminal.toolModelResultId,
        ...(call.providerCallId ? { providerCallId: call.providerCallId } : {})
      });
    }
  }

  private async readModelRequestToolDefinitions(modelRequestId: string): Promise<ReliableAgentToolDefinition[]> {
    const request = await this.requireExisting('ModelRequest', modelRequestId);
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(request.recipe_object_id, 'ModelRequest.recipe_object_id')
    ) as unknown as ContentObjectMetadata;
    const recipe = requireRecord(
      normalizePlainJson(JSON.parse((await this.contentStore.read(metadata)).toString('utf8')), 'ModelRequest recipe'),
      'ModelRequest recipe'
    );
    if (!Array.isArray(recipe.tools)) throw new TypeError('ModelRequest recipe.tools must be an array.');
    return recipe.tools.map((value, index) => normalizeFrozenToolDefinition(value, index));
  }

  private async dispatchAndCapture(
    conversationId: string,
    turnId: string,
    modelRequestId: string,
    request: DomainRow
  ): Promise<NormalizedProviderOutput> {
    const providerId = requireText(request.provider_id, 'ModelRequest.provider_id');
    const modelId = requireText(request.model_id, 'ModelRequest.model_id');
    const requestSeq = requirePositiveInteger(request.request_seq, 'ModelRequest.request_seq').toString();
    const adapter = await this.providers.resolve(providerId);
    if (adapter.providerId !== providerId) throw new Error(`Provider registry returned ${adapter.providerId} for ${providerId}.`);
    const dispatchBarrier = await this.database.snapshot([]);
    const wrapped: FullRequestProviderAdapter = {
      providerId,
      sendFullRequest: (fullRequest, controls) => adapter.sendFullRequest(fullRequest, {
        signal: controls.signal,
        onEvent: async (event): Promise<StreamEventResult> => {
          this.observeTransientEvent({
            conversationId,
            turnId,
            modelRequestId,
            requestSeq,
            providerId,
            modelId,
            attemptSeq: fullRequest.attemptSeq,
            socketGeneration: fullRequest.socketGeneration,
            afterCommitSeq: dispatchBarrier.snapshotCommitSeq,
            event: {
              kind: event.kind,
              streamSeq: event.streamSeq,
              content: event.content,
              ...(event.usage !== undefined ? { usage: event.usage } : {}),
              ...(event.timing !== undefined ? { timing: event.timing } : {})
            },
            observedAt: this.timestamp()
          });
          return controls.onEvent(event);
        }
      })
    };
    const streamStats = asRecord(request.stream_stats_json);
    const reconnect = reliableDecimal(streamStats?.socketGeneration) > 0n || request.status === 'streaming';
    await this.modelProvider.dispatch(modelRequestId, wrapped, {
      ...(reconnect ? { reconnect: true } : {}),
      onTransientTerminal: (terminal) => this.observeTransientEvent({
        conversationId,
        turnId,
        modelRequestId,
        requestSeq,
        providerId,
        modelId,
        attemptSeq: terminal.attemptSeq,
        socketGeneration: terminal.socketGeneration,
        afterCommitSeq: dispatchBarrier.snapshotCommitSeq,
        event: terminal.event,
        observedAt: this.timestamp()
      })
    });
    // The terminal CAS checkpoint is the only final-output authority. The transient collector exists
    // solely to drive low-latency UI observation and must never become a second durable result path.
    return this.readTerminalProviderOutput(modelRequestId);
  }

  private async readLoopTerminalStatus(
    turnId: string,
    turn: DomainRow
  ): Promise<ReliableAgentLoopResult['terminalStatus']> {
    if (turn.status !== 'terminated') return 'failed';
    const terminations = await this.list('TurnTermination', { turn_id: turnId }, 2);
    if (terminations.length !== 1) {
      throw new Error(`Terminated Turn ${turnId} must have exactly one TurnTermination.`);
    }
    if (terminations[0].terminal_status === 'completed') return 'completed';
    if (terminations[0].terminal_status === 'interrupted') return 'interrupted';
    return 'failed';
  }

  private async readTerminalProviderOutput(modelRequestId: string): Promise<NormalizedProviderOutput> {
    const checkpoints = await this.list('ModelStreamCheckpoint', { model_request_id: modelRequestId }, 512);
    const terminal = checkpoints
      .filter((row) => row.checkpoint_kind === 'terminal_summary')
      .sort((left, right) => compareInteger(right.stream_seq, left.stream_seq))[0];
    if (!terminal) throw new Error(`Terminal ModelRequest ${modelRequestId} has no terminal summary checkpoint.`);
    const metadata = await this.requireExisting('ContentObject', requireId(terminal.content_object_id, 'ModelStreamCheckpoint.content_object_id'));
    const bytes = await this.contentStore.read(metadata as unknown as ContentObjectMetadata);
    const envelope = normalizePlainJson(JSON.parse(bytes.toString('utf8')), 'Model terminal checkpoint');
    const record = requireRecord(envelope, 'Model terminal checkpoint');
    if (record.kind !== 'completed') throw new Error('Model terminal checkpoint is not a completed event.');
    return normalizeProviderOutput(record.content);
  }

  private async readRoundFacts(turnId: string): Promise<{ turn: DomainRow; authority: DomainRow; head: DomainRow }> {
    const turn = await this.requireExisting('Turn', turnId);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({ where: { conversation_id: conversationId }, limit: 2 })
    ]);
    const authorities = rows(snapshot.snapshot[0]);
    const heads = rows(snapshot.snapshot[1]);
    if (authorities.length !== 1) throw new Error(`Turn ${turnId} must have exactly one AuthoritySnapshot.`);
    if (heads.length !== 1) throw new Error(`Conversation ${conversationId} must have exactly one Context head.`);
    return { turn, authority: authorities[0], head: heads[0] };
  }

  /**
   * Returns the last durable request sequence, or 1 for a fresh Turn. Replaying the last sequence
   * is required: request existence alone does not prove that its assistant Message, every tool
   * result and every Context tool_pair were committed before a crash.
   */
  private async resumeRequestSequence(turnId: string): Promise<bigint> {
    const requests = (await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turnId }))
      .sort((left, right) => compareInteger(left.request_seq, right.request_seq));
    let expectedPhysicalSequence = 1n;
    let normalRound = 0n;
    for (const request of requests) {
      const actual = requirePositiveInteger(request.request_seq, 'ModelRequest.request_seq');
      if (actual !== expectedPhysicalSequence) {
        throw new Error(`Turn ${turnId} ModelRequest sequence is not contiguous at ${expectedPhysicalSequence.toString()}.`);
      }
      const recipe = await this.readModelRequestRecipe(requireId(request.id, 'ModelRequest.id'));
      if (recipe.kind === 'reliable-agent-turn') {
        normalRound += 1n;
        const round = requirePositiveInteger(recipe.round, 'ModelRequest recipe.round');
        if (round !== normalRound) {
          throw new Error(`Turn ${turnId} ordinary ModelRequest round is not contiguous at ${normalRound.toString()}.`);
        }
        const expectedId = modelRequestIdFor(turnId, `agent-loop:${turnId}:round:${normalRound.toString()}`);
        if (request.id !== expectedId) {
          throw new Error(`Turn ${turnId} ordinary ModelRequest ${normalRound.toString()} has an invalid identity.`);
        }
      } else if (recipe.kind !== 'reliable-context-compression') {
        throw new Error(`Turn ${turnId} ModelRequest ${String(request.id)} has unsupported recipe kind ${String(recipe.kind)}.`);
      }
      expectedPhysicalSequence += 1n;
    }
    return normalRound === 0n ? 1n : normalRound;
  }

  private async cancelSupersededCompressionRequests(turnId: string, currentHeadRootId: string): Promise<void> {
    const requests = await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turnId });
    for (const request of requests) {
      if (request.status === 'terminal') continue;
      const requestId = requireId(request.id, 'ModelRequest.id');
      const recipe = await this.readModelRequestRecipe(requestId);
      if (recipe.kind !== 'reliable-context-compression') continue;
      const sourceRootId = requireId(recipe.sourceRootId, 'Compression recipe.sourceRootId');
      if (sourceRootId === currentHeadRootId) continue;
      await this.modelProvider.cancel(requestId, 'compression-source-head-superseded-before-recovery');
    }
  }

  private async assertModelRequestRound(request: DomainRow, expected: bigint, expectedId: string): Promise<void> {
    if (request.id !== expectedId) throw new Error('ModelProvider returned an unexpected stable ModelRequest identity.');
    const recipe = await this.readModelRequestRecipe(expectedId);
    const actual = requirePositiveInteger(recipe.round, 'ModelRequest recipe.round');
    if (recipe.kind !== 'reliable-agent-turn' || actual !== expected) {
      throw new Error(
        `ModelRequest ${expectedId} recipe round ${actual.toString()} does not match durable round ${expected.toString()}.`
      );
    }
  }

  private async readModelRequestRecipe(modelRequestId: string): Promise<{ [key: string]: PlainJsonValue }> {
    const request = await this.requireExisting('ModelRequest', modelRequestId);
    const metadata = await this.requireExisting(
      'ContentObject', requireId(request.recipe_object_id, 'ModelRequest.recipe_object_id')
    ) as unknown as ContentObjectMetadata;
    return requireRecord(
      normalizePlainJson(JSON.parse((await this.contentStore.read(metadata)).toString('utf8')), 'ModelRequest recipe'),
      'ModelRequest recipe'
    );
  }

  private async requireTerminalToolResult(toolCallId: string): Promise<ToolTerminalResult> {
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    if (!terminal) throw new Error(`ToolCall ${toolCallId} has no terminal model result.`);
    return terminal;
  }

  private async absorbRuntimeDeliveryInputs(turnId: string): Promise<number> {
    const deliveries = (await listAllDomainRows(this.database, 'RuntimeDelivery', {
      target_turn_id: turnId,
      phase: 'current_turn',
      state: 'pending'
    })).sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    for (const delivery of deliveries) {
      await this.runtimeDeliveries.advance(requireId(delivery.id, 'RuntimeDelivery.id'));
    }
    const pending = (await listAllDomainRows(this.database, 'PendingTurnInput', {
      turn_id: turnId,
      state: 'pending',
      input_kind: 'runtime_delivery'
    }))
      .sort((left, right) => compareInteger(left.position, right.position));
    if (pending.length === 0) return 0;
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== 'active') return 0;
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    let absorbed = 0;
    for (const input of pending) {
      const inputId = requireId(input.id, 'PendingTurnInput.id');
      const contentObjectId = requireId(input.content_object_id, 'PendingTurnInput.content_object_id');
      const metadata = await this.requireExisting('ContentObject', contentObjectId) as unknown as ContentObjectMetadata;
      const content = await this.contentStore.read(metadata);
      await this.context.appendContent({
        conversationId,
        segmentKind: 'runtime_context',
        source: {
          sourceKind: 'runtime_context',
          sourceId: inputId,
          // Runtime context identity is carried by the stable PendingTurnInput id. Unlike a
          // MessageRevision or tool call sequence it has no revision axis; ContextSequence's
          // source contract therefore requires the sentinel revision 0.
          sourceRevision: 0n
        },
        content,
        contentType: requireText(metadata.content_type, 'ContentObject.content_type')
      });
      await this.runtimeDeliveries.markInputHandled(inputId);
      absorbed += 1;
    }
    return absorbed;
  }

  private async terminateIfRequested(
    turnId: string,
    stage: string,
    pendingToolCallId?: string
  ): Promise<boolean> {
    for (;;) {
      const turn = await this.requireExisting('Turn', turnId);
      if (turn.status !== 'active') return turn.status === 'terminated';
      const request = (await this.listPendingTerminationInputs(turnId))
        .sort((left, right) => compareInteger(left.position, right.position))[0];
      if (!request) return false;

      // Cancellation may race between ModelRequest/ToolCall creation and external dispatch. Close
      // every durable wait, then absorb any concurrently delivered runtime context before the
      // interrupted terminal writer ACKs termination inputs and releases the exact lease.
      await this.modelProvider.cancelTurnDispatches(turnId, `termination request observed at ${stage}`);
      await this.tools.cancelWaiting?.({
        turnId,
        sourceKey: `agent-loop:${turnId}:termination-request:${request.id}`,
        reason: `Turn observed ${String(request.input_kind)} at ${stage}.`
      });
      await this.closeInterruptedToolContext(turnId, requireId(request.id, 'PendingTurnInput.id'), pendingToolCallId);
      await this.absorbRuntimeDeliveryInputs(turnId);
      try {
        await this.turns.terminal({
          source: { kind: 'internal', key: `agent-loop:${turnId}:termination-request:${request.id}` },
          turnId,
          terminalStatus: 'interrupted',
          reason: `Executor observed ${String(request.input_kind)} at ${stage}.`
        });
        return true;
      } catch (error) {
        if (isTurnTerminalInputConflictError(error)) continue;
        throw error;
      }
    }
  }

  /**
   * A committed assistant message may contain several function calls while only the first call has
   * reached a durable user/file wait. Before terminating the Turn, materialize and cancel every
   * call represented by that committed message, then append each terminal tool_pair in provider
   * order. This keeps the next Provider request canonical after interruption and is safe to replay.
   */
  private async closeInterruptedToolContext(
    turnId: string,
    terminationRequestId: string,
    pendingToolCallId?: string
  ): Promise<void> {
    const turn = await this.requireExisting('Turn', turnId);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const representedToolCallIds = new Set<string>();
    const requests = (await listAllDomainRows(this.database, 'ModelRequest', {
      turn_id: turnId,
      status: 'terminal',
      terminal_state: 'completed'
    }))
      .sort((left, right) => compareInteger(left.request_seq, right.request_seq));

    for (const request of requests) {
      const modelRequestId = requireId(request.id, 'ModelRequest.id');
      const committedAssistant = await this.maybeGet('Message', assistantMessageIdFor(turnId, modelRequestId));
      if (!committedAssistant) continue;
      const output = await this.readTerminalProviderOutput(modelRequestId);
      if (output.toolCalls.length === 0) continue;
      const batch = await this.prepareProviderToolBatch({
        turnId,
        modelRequestId,
        messageId: requireId(committedAssistant.id, 'Assistant Message.id'),
        output
      });
      for (const call of batch) {
        const toolCallId = call.toolCallId;
        representedToolCallIds.add(toolCallId);
        let terminal = await this.effects.readTerminalResult(toolCallId, false);
        if (!terminal) {
          await this.cancelUndispatchedToolEffects(
            toolCallId,
            `agent-loop:${turnId}:termination-request:${terminationRequestId}`
          );
          const settled = await this.effects.settleWithoutEffect({
            source: {
              kind: 'internal',
              key: `agent-loop:${turnId}:termination-request:${terminationRequestId}:cancel-tool:${toolCallId}`
            },
            toolCallId,
            status: 'cancelled',
            detail: { reason: 'turn_termination_requested' }
          });
          terminal = settled.terminal ?? await this.requireTerminalToolResult(toolCallId);
        }
        await this.appendTerminalToolPairOnce({
          conversationId,
          toolCallId,
          toolModelResultId: terminal.toolModelResultId,
          ...(call.providerCallId ? { providerCallId: call.providerCallId } : {})
        });
      }
    }

    if (pendingToolCallId && !representedToolCallIds.has(pendingToolCallId)
      && !await this.effects.readTerminalResult(pendingToolCallId, false)) {
      await this.cancelUndispatchedToolEffects(
        pendingToolCallId,
        `agent-loop:${turnId}:termination-request:${terminationRequestId}`
      );
      await this.effects.settleWithoutEffect({
        source: {
          kind: 'internal',
          key: `agent-loop:${turnId}:termination-request:${terminationRequestId}:cancel-unrepresented-tool:${pendingToolCallId}`
        },
        toolCallId: pendingToolCallId,
        status: 'cancelled',
        detail: { reason: 'turn_termination_requested' }
      });
    }
  }

  /** A prepared Effect may be cancelled; a dispatched Effect must first produce/recover a Receipt. */
  private async cancelUndispatchedToolEffects(toolCallId: string, sourcePrefix: string): Promise<void> {
    const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    for (const operation of operations) {
      if (isTerminalToolStatus(operation.status)) continue;
      const attempts = await listAllDomainRows(this.database, 'Attempt', { operation_id: operation.id });
      for (const attempt of attempts) {
        const intents = await this.list('EffectIntent', { attempt_id: attempt.id }, 2);
        if (intents.length > 1) throw new Error(`Attempt ${String(attempt.id)} has multiple EffectIntents.`);
        if (intents[0]?.dispatch_state !== 'pending') continue;
        await this.effects.cancelPendingEffect({
          source: {
            kind: 'internal',
            key: `${sourcePrefix}:cancel-before-dispatch:${String(intents[0].id)}`
          },
          effectIntentId: requireId(intents[0].id, 'EffectIntent.id'),
          detail: { reason: 'turn_termination_requested_before_effect_dispatch' }
        });
      }
    }
    const remaining = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    const unresolved = remaining.filter((operation) => !isTerminalToolStatus(operation.status));
    if (unresolved.length > 0) {
      throw new Error(
        `ToolCall ${toolCallId} still has non-terminal Operations after cancellation: ${unresolved
          .map((operation) => `${String(operation.id)}=${String(operation.status)}`)
          .join(', ')}.`
      );
    }
  }

  private async appendTerminalToolPairOnce(input: {
    conversationId: string;
    toolCallId: string;
    toolModelResultId: string;
    providerCallId?: string;
  }): Promise<void> {
    const sources = await this.list('ContextSegmentSource', {
      source_kind: 'tool_model_result',
      source_id: input.toolModelResultId
    }, 2);
    if (sources.length > 1) {
      throw new Error(`ToolModelResult ${input.toolModelResultId} has multiple Context occurrences.`);
    }
    if (sources.length === 1) {
      const callSources = await this.list('ContextSegmentSource', {
        segment_id: requireId(sources[0].segment_id, 'ContextSegmentSource.segment_id'),
        source_kind: 'tool_call'
      }, 2);
      if (callSources.length !== 1 || callSources[0].source_id !== input.toolCallId) {
        throw new Error(`ToolModelResult ${input.toolModelResultId} is linked to a conflicting Context tool pair.`);
      }
      return;
    }
    await this.context.appendToolPair(input);
  }

  private async failActiveTurn(turnId: string, error: unknown): Promise<void> {
    const reason = errorMessage(error);
    for (;;) {
      const turn = await this.maybeGet('Turn', turnId);
      if (!turn || turn.status !== 'active') return;
      if (await this.terminateIfRequested(turnId, 'failure-terminal')) return;
      await this.absorbRuntimeDeliveryInputs(turnId);
      try {
        await this.turns.terminal({
          source: {
            kind: 'internal',
            key: `agent-loop:${turnId}:failed:${stableDigest(reason)}`
          },
          turnId,
          terminalStatus: 'failed',
          reason
        });
        return;
      } catch (terminalError) {
        if (isTurnTerminalInputConflictError(terminalError)) continue;
        throw terminalError;
      }
    }
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return snapshot.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    return rows(snapshot.snapshot[0]);
  }

  private async listPendingTerminationInputs(turnId: string): Promise<DomainRow[]> {
    const groups = await Promise.all(TERMINATION_INPUT_KINDS.map((inputKind) => listAllDomainRows(
      this.database,
      'PendingTurnInput',
      { turn_id: turnId, state: 'pending', input_kind: inputKind }
    )));
    return groups.flat();
  }

  private observeLifecycle(event: Omit<ReliableAgentLifecycleEvent, 'observedAt'>): void {
    if (!this.lifecycleObserver) return;
    try {
      this.lifecycleObserver.observe({ ...event, observedAt: this.timestamp() });
    } catch {
      // Diagnostics must never become a second control path or break the Agent loop.
    }
  }

  private observeTransientEvent(event: ReliableAgentTransientEvent): void {
    if (!this.transientObserver) return;
    try {
      this.transientObserver.observe(event);
    } catch {
      // A memory-only low-latency overlay must never become a Provider/Turn control path.
    }
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

const TERMINATION_INPUT_KINDS = [
  'interrupt_request',
  'interrupt_current_turn',
  'termination_request'
] as const;

function isTerminalToolStatus(value: unknown): boolean {
  return ['succeeded', 'failed', 'partial', 'rejected', 'cancelled', 'conflict', 'outcome_unknown']
    .includes(String(value));
}

function providerOutputMessage(output: NormalizedProviderOutput): MessageContent {
  return {
    role: 'model',
    parts: [
      ...(output.thought || output.thoughtDurationMs !== undefined ? [{
        text: output.thought,
        thought: true as const,
        ...(output.thoughtSignature ? { thoughtSignature: output.thoughtSignature } : {}),
        ...(output.thoughtDurationMs !== undefined ? { thoughtDurationMs: output.thoughtDurationMs } : {})
      }] : []),
      ...(output.text ? [{ text: output.text }] : []),
      ...output.toolCalls.map((call) => ({
        ...(call.providerCallId ? { id: call.providerCallId } : {}),
        functionCall: { name: call.name, args: call.arguments },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
      }))
    ]
  };
}

function normalizeProviderOutput(value: PlainJsonValue): NormalizedProviderOutput {
  const record = requireRecord(value, 'Provider completed content');
  return {
    text: optionalText(record.text),
    thought: optionalText(record.thought),
    ...(optionalText(record.thoughtSignature) ? { thoughtSignature: optionalText(record.thoughtSignature) } : {}),
    ...(optionalNonNegativeInteger(record.thoughtDurationMs) !== undefined
      ? { thoughtDurationMs: optionalNonNegativeInteger(record.thoughtDurationMs) }
      : {}),
    toolCalls: normalizeToolCalls(record.toolCalls),
    ...(record.usage !== undefined ? { usage: record.usage } : {})
  };
}

function normalizeToolCalls(value: unknown): NormalizedToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Provider toolCalls must be an array.');
  const normalized: NormalizedToolCall[] = [];
  const byProviderCallId = new Map<string, { signature: string; index: number }>();
  const byExplicitOrdinal = new Map<number, number>();
  const explicitOrdinalByIndex: Array<number | undefined> = [];
  value.forEach((entry, index) => {
    const record = requireRecord(entry as PlainJsonValue, `Provider toolCall ${index}`);
    const name = requireText(record.name, `Provider toolCall ${index}.name`);
    let argumentsValue = record.arguments;
    if (typeof record.argumentsJson === 'string') {
      argumentsValue = normalizePlainJson(JSON.parse(record.argumentsJson), `Provider toolCall ${index}.argumentsJson`);
    }
    const providerCallId = optionalText(record.id);
    const explicitOrdinal = optionalNonNegativeInteger(record.ordinal);
    const providerOrdinal = explicitOrdinal ?? index;
    const call: NormalizedToolCall = {
      ...(providerCallId ? { providerCallId } : {}),
      providerOrdinal,
      name,
      arguments: normalizePlainJson(argumentsValue ?? {}, `Provider toolCall ${index}.arguments`),
      ...(optionalText(record.thoughtSignature) ? { thoughtSignature: optionalText(record.thoughtSignature) } : {})
    };
    const signature = canonicalPlainJson({
      name: call.name,
      arguments: call.arguments
    }, 'Provider toolCall signature');
    const idIdentity = providerCallId ? byProviderCallId.get(providerCallId) : undefined;
    const ordinalIdentity = explicitOrdinal === undefined ? undefined : byExplicitOrdinal.get(explicitOrdinal);
    if (idIdentity !== undefined && ordinalIdentity !== undefined && idIdentity.index !== ordinalIdentity) {
      throw new Error(
        `Provider tool call id ${providerCallId} and ordinal ${explicitOrdinal} identify different calls.`
      );
    }
    const existingIndex = idIdentity?.index ?? ordinalIdentity;
    if (existingIndex !== undefined) {
      const prior = normalized[existingIndex];
      if (prior.providerCallId && providerCallId && prior.providerCallId !== providerCallId) {
        throw new Error(
          `Provider reused tool call ordinal ${explicitOrdinal} for ids ${prior.providerCallId} and ${providerCallId}.`
        );
      }
      const priorSignature = canonicalPlainJson({
        name: prior.name,
        arguments: prior.arguments
      }, 'Provider prior toolCall signature');
      if (priorSignature !== signature) {
        const identity = providerCallId ? `id ${providerCallId}` : `ordinal ${explicitOrdinal}`;
        throw new Error(`Provider reused tool call ${identity} with conflicting content.`);
      }
      const priorExplicitOrdinal = explicitOrdinalByIndex[existingIndex];
      if (
        explicitOrdinal !== undefined
        && priorExplicitOrdinal !== undefined
        && priorExplicitOrdinal !== explicitOrdinal
      ) {
        throw new Error(`Provider reused tool call id ${providerCallId} with ordinal ${explicitOrdinal}.`);
      }
      if (prior.thoughtSignature && call.thoughtSignature && prior.thoughtSignature !== call.thoughtSignature) {
        const identity = providerCallId ? `id ${providerCallId}` : `ordinal ${explicitOrdinal}`;
        throw new Error(`Provider reused tool call ${identity} with conflicting thoughtSignature.`);
      }
      if (!prior.providerCallId && providerCallId) {
        prior.providerCallId = providerCallId;
        byProviderCallId.set(providerCallId, { signature, index: existingIndex });
      }
      if (priorExplicitOrdinal === undefined && explicitOrdinal !== undefined) {
        prior.providerOrdinal = explicitOrdinal;
        explicitOrdinalByIndex[existingIndex] = explicitOrdinal;
        byExplicitOrdinal.set(explicitOrdinal, existingIndex);
      }
      if (!prior.thoughtSignature && call.thoughtSignature) prior.thoughtSignature = call.thoughtSignature;
      return;
    }
    if (providerCallId) byProviderCallId.set(providerCallId, { signature, index: normalized.length });
    if (explicitOrdinal !== undefined) byExplicitOrdinal.set(explicitOrdinal, normalized.length);
    explicitOrdinalByIndex.push(explicitOrdinal);
    normalized.push(call);
  });
  const ordinals = new Set<number>();
  for (const call of normalized) {
    if (ordinals.has(call.providerOrdinal)) {
      throw new Error(`Provider repeated tool call ordinal ${call.providerOrdinal}.`);
    }
    ordinals.add(call.providerOrdinal);
  }
  return normalized;
}

function isToolPause(
  value: ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled
): value is ReliableAgentToolPause {
  return 'disposition' in value && value.disposition === 'paused';
}

function providerToolCallId(modelRequestId: string, call: NormalizedToolCall): string {
  return stableId(
    'tool_call',
    modelRequestId,
    String(call.providerOrdinal),
    call.providerCallId ?? call.name
  );
}

function normalizeFrozenToolDefinition(value: PlainJsonValue, index: number): ReliableAgentToolDefinition {
  const record = requireRecord(value, `ModelRequest recipe.tools[${index}]`);
  return {
    name: requireText(record.name, `ModelRequest recipe.tools[${index}].name`),
    description: optionalText(record.description),
    parameters: normalizePlainJson(record.parameters ?? {}, `ModelRequest recipe.tools[${index}].parameters`),
    ...(record.source !== undefined
      ? { source: normalizePlainJson(record.source, `ModelRequest recipe.tools[${index}].source`) }
      : {}),
    ...(record.metadata !== undefined
      ? { metadata: normalizePlainJson(record.metadata, `ModelRequest recipe.tools[${index}].metadata`) }
      : {}),
    ...(record.defaultConfig !== undefined
      ? { defaultConfig: normalizePlainJson(record.defaultConfig, `ModelRequest recipe.tools[${index}].defaultConfig`) }
      : {})
  };
}

function unknownToolDefinition(name: string): ReliableAgentToolDefinition {
  return {
    name,
    description: '',
    parameters: {},
    metadata: { defaultEnabled: false }
  };
}

function fallbackFrozenToolPolicy(
  definition: ReliableAgentToolDefinition,
  argumentsValue: PlainJsonValue
): FrozenToolCallPolicyDecision {
  const metadata = asRecord(definition.metadata);
  const args = asRecord(argumentsValue);
  const explicitScheduling = args?.scheduling === 'parallel' || args?.scheduling === 'serial'
    ? args.scheduling
    : undefined;
  const schedulingMode = explicitScheduling
    ?? (metadata?.readonly === true || metadata?.riskLevel === 'read' ? 'parallel' : 'serial');
  const supportsChangeApply = metadata?.supportsChangeApply === true;
  const automaticChangeApply = supportsChangeApply && metadata?.defaultAutoApplyChange === true;
  const configuredDelay = optionalNonNegativeInteger(metadata?.defaultAutoApplyChangeDelaySeconds) ?? 0;
  return {
    displayAutoExpand: metadata?.defaultAutoExpand === true,
    displayAutoOpenDiff: metadata?.defaultAutoOpenDiffPreview === true,
    executionGate: ['ask_user', 'submit_plan'].includes(definition.name)
      || metadata?.defaultAutoApproveExecution !== false
      ? 'automatic'
      : 'approval_required',
    changeApplyMode: supportsChangeApply
      ? automaticChangeApply ? 'automatic' : 'manual'
      : 'unsupported',
    changeApplyDelaySeconds: automaticChangeApply ? Math.min(configuredDelay, 600) : 0,
    autoSubmitResult: metadata?.defaultAutoSubmitResult !== false,
    schedulingMode,
    schedulingReason: explicitScheduling
      ? `provider_selected_${explicitScheduling}`
      : schedulingMode === 'parallel' ? 'frozen_readonly_metadata' : 'frozen_default_serial'
  };
}

function frozenPolicyFromRow(row: DomainRow): FrozenToolCallPolicyDecision {
  const executionGate = String(row.execution_gate);
  const changeApplyMode = String(row.change_apply_mode);
  const schedulingMode = String(row.scheduling_mode);
  if (!['automatic', 'approval_required'].includes(executionGate)) {
    throw new TypeError(`Invalid frozen Tool execution gate: ${executionGate}.`);
  }
  if (!['automatic', 'manual', 'unsupported'].includes(changeApplyMode)) {
    throw new TypeError(`Invalid frozen Tool change-apply mode: ${changeApplyMode}.`);
  }
  if (!['parallel', 'serial'].includes(schedulingMode)) {
    throw new TypeError(`Invalid frozen Tool scheduling mode: ${schedulingMode}.`);
  }
  return {
    ...(typeof row.summary === 'string' ? { summary: row.summary } : {}),
    displayAutoExpand: row.display_auto_expand === 1n,
    displayAutoOpenDiff: row.display_auto_open_diff === 1n,
    executionGate: executionGate as FrozenToolCallPolicyDecision['executionGate'],
    changeApplyMode: changeApplyMode as FrozenToolCallPolicyDecision['changeApplyMode'],
    changeApplyDelaySeconds: requireNonNegativeSafeNumber(
      row.change_apply_delay_seconds,
      'ToolCallPolicySnapshot.change_apply_delay_seconds'
    ),
    autoSubmitResult: row.auto_submit_result === 1n,
    schedulingMode: schedulingMode as FrozenToolCallPolicyDecision['schedulingMode'],
    ...(typeof row.scheduling_reason === 'string' ? { schedulingReason: row.scheduling_reason } : {})
  };
}

function requireNonNegativeSafeNumber(value: unknown, label: string): number {
  const bigint = typeof value === 'bigint'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value)
      : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? BigInt(value)
        : -1n;
  if (bigint < 0n || bigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return Number(bigint);
}

function rows(value: DomainRow | DomainRow[] | null): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list did not return rows.');
  return value;
}

function requireRecord(value: PlainJsonValue, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function reliableDecimal(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return 0n;
}

function requirePositiveInteger(value: unknown, label: string): bigint {
  const normalized = reliableDecimal(value);
  if (normalized < 1n) throw new TypeError(`${label} must be a positive integer.`);
  return normalized;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function compareInteger(left: unknown, right: unknown): number {
  const a = reliableDecimal(left);
  const b = reliableDecimal(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableId(kind: string, ...parts: string[]): string {
  return `rk_${kind}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function errorDiagnostic(error: unknown): Pick<ReliableAgentLifecycleEvent, 'errorName' | 'errorMessage'> {
  return {
    errorName: error instanceof Error ? error.name : 'NonError',
    errorMessage: errorMessage(error, 500)
  };
}

function errorMessage(error: unknown, maxLength = 2_000): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= maxLength ? message : `${message.slice(0, Math.max(0, maxLength - 3))}...`;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}
