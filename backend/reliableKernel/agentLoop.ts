import { createHash } from 'node:crypto';
import type { MessageContent } from '../../shared/protocol';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { ContextSequenceControlPlane } from './contextSequence';
import {
  EffectControlPlane,
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
import { RuntimeDatabase } from './runtimeDatabase';
import { TurnControlPlane, type TurnInputCommand } from './turnControlPlane';
import { TurnOutputControlPlane } from './turnOutput';

export interface ReliableAgentToolDefinition {
  name: string;
  description: string;
  parameters: PlainJsonValue;
}

export interface ReliableAgentProviderRegistry {
  resolve(providerId: string): Promise<FullRequestProviderAdapter> | FullRequestProviderAdapter;
  dispose?(): Promise<void> | void;
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
  reason: 'awaiting_user' | 'awaiting_approval' | 'awaiting_child' | 'background_process';
  resumeKey?: string;
}

/** Dispatcher owns capability-specific EffectIntent/Receipt semantics and may durably pause the Turn. */
export interface ReliableAgentToolDispatcher {
  definitions(): Promise<ReliableAgentToolDefinition[]> | ReliableAgentToolDefinition[];
  dispatch(input: ReliableAgentToolDispatchInput): Promise<ToolTerminalResult | ReliableAgentToolPause>;
  dispose?(): Promise<void> | void;
}

export interface ReliableAgentTransientEvent {
  conversationId: string;
  turnId: string;
  modelRequestId: string;
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
  round?: number;
  modelRequestId?: string;
  toolCallId?: string;
  errorName?: string;
  errorMessage?: string;
}

export interface ReliableAgentLifecycleObserver {
  observe(event: ReliableAgentLifecycleEvent): void;
}

export interface ReliableAgentLoopResult {
  turnId: string;
  terminalStatus: 'completed' | 'failed' | 'waiting';
  modelRequestIds: string[];
  assistantMessageIds: string[];
  toolCallIds: string[];
  waitingToolCallId?: string;
}

interface NormalizedToolCall {
  providerCallId?: string;
  name: string;
  arguments: PlainJsonValue;
}

interface NormalizedProviderOutput {
  text: string;
  thought: string;
  thoughtSignature?: string;
  toolCalls: NormalizedToolCall[];
  usage?: PlainJsonValue;
}

const MAX_TOOL_ROUNDS = 32;
const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';

/**
 * 单 Turn 的可靠 Agent loop。每轮都冻结 Context root/authority，Provider 完成摘要先落 SQLite/CAS，
 * 再幂等提交 assistant Message；工具结果按 call_seq 持久化并追加 Context tool_pair。
 */
export class ReliableAgentLoop {
  private readonly context: ContextSequenceControlPlane;
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly turns: TurnControlPlane,
    private readonly turnOutput: TurnOutputControlPlane,
    private readonly modelProvider: ModelProviderControlPlane,
    private readonly effects: EffectControlPlane,
    private readonly providers: ReliableAgentProviderRegistry,
    private readonly tools: ReliableAgentToolDispatcher,
    private readonly transientObserver?: ReliableAgentTransientObserver,
    private readonly lifecycleObserver?: ReliableAgentLifecycleObserver,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
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
      for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
        const facts = await this.readRoundFacts(turnId);
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
          return { turnId, terminalStatus: 'failed', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        const toolDefinitions = await this.tools.definitions();
        const idempotencyKey = `agent-loop:${turnId}:round:${round}`;
        const expectedModelRequestId = modelRequestIdFor(turnId, idempotencyKey);
        let request = await this.maybeGet('ModelRequest', expectedModelRequestId);
        if (!request) {
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
        const modelRequestId = expectedModelRequestId;
        modelRequestIds.push(modelRequestId);
        if (await this.terminateIfRequested(turnId, `round:${round}:model-request:${modelRequestId}`)) {
          return { turnId, terminalStatus: 'failed', modelRequestIds, assistantMessageIds, toolCallIds };
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
          return { turnId, terminalStatus: 'failed', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        this.observeLifecycle({ turnId, stage: 'assistant_commit_started', round, modelRequestId });
        const message = await this.turnOutput.appendAssistantMessage({
          turnId,
          sourceKey: modelRequestId,
          content: JSON.stringify(providerOutputMessage(output)),
          contentType: MESSAGE_CONTENT_TYPE
        });
        assistantMessageIds.push(message.messageId);
        this.observeLifecycle({ turnId, stage: 'assistant_commit_completed', round, modelRequestId });

        if (output.toolCalls.length === 0) {
          if (await this.terminateIfRequested(turnId, `round:${round}:before-complete:${modelRequestId}`)) {
            return { turnId, terminalStatus: 'failed', modelRequestIds, assistantMessageIds, toolCallIds };
          }
          this.observeLifecycle({ turnId, stage: 'turn_terminal_started', round, modelRequestId });
          await this.turns.terminal({
            source: { kind: 'internal', key: `agent-loop:${turnId}:complete:${modelRequestId}` },
            turnId,
            terminalStatus: 'completed',
            reason: 'model_completed_without_tool_calls'
          });
          this.observeLifecycle({ turnId, stage: 'turn_terminal_completed', round, modelRequestId });
          return { turnId, terminalStatus: 'completed', modelRequestIds, assistantMessageIds, toolCallIds };
        }

        for (let index = 0; index < output.toolCalls.length; index += 1) {
          if (await this.terminateIfRequested(turnId, `round:${round}:before-tool:${index + 1}`)) {
            return { turnId, terminalStatus: 'failed', modelRequestIds, assistantMessageIds, toolCallIds };
          }
          const call = output.toolCalls[index];
          const toolCallId = stableId('tool_call', modelRequestId, String(index + 1), call.providerCallId ?? call.name);
          toolCallIds.push(toolCallId);
          await this.effects.createToolCall({
            source: { kind: 'callback', key: `agent-loop:${modelRequestId}:tool:${index + 1}` },
            toolCallId,
            turnId,
            toolName: call.name,
            arguments: call.arguments
          });
          if (await this.terminateIfRequested(
            turnId,
            `round:${round}:created-tool:${index + 1}`,
            toolCallId
          )) {
            return { turnId, terminalStatus: 'failed', modelRequestIds, assistantMessageIds, toolCallIds };
          }
          let terminal = await this.effects.readTerminalResult(toolCallId, false);
          if (!terminal) {
            try {
              this.observeLifecycle({ turnId, stage: 'tool_dispatch_started', round, modelRequestId, toolCallId });
              const dispatched = await this.tools.dispatch({
                turnId,
                modelRequestId,
                toolCallId,
                ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
                toolName: call.name,
                arguments: call.arguments
              });
              if (isToolPause(dispatched)) {
                return {
                  turnId,
                  terminalStatus: 'waiting',
                  modelRequestIds,
                  assistantMessageIds,
                  toolCallIds,
                  waitingToolCallId: toolCallId
                };
              }
              terminal = dispatched;
              this.observeLifecycle({ turnId, stage: 'tool_dispatch_completed', round, modelRequestId, toolCallId });
            } catch (error) {
              const failed = await this.effects.settleWithoutEffect({
                source: { kind: 'internal', key: `agent-loop:${toolCallId}:dispatcher-failed` },
                toolCallId,
                status: 'failed',
                detail: { error: error instanceof Error ? error.message : String(error) }
              });
              terminal = failed.terminal ?? await this.requireTerminalToolResult(toolCallId);
            }
          }
          await this.context.appendToolPair({
            conversationId: requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
            toolCallId,
            toolModelResultId: terminal.toolModelResultId,
            ...(call.providerCallId ? { providerCallId: call.providerCallId } : {})
          });
          if (await this.terminateIfRequested(turnId, `round:${round}:after-tool:${index + 1}`)) {
            return { turnId, terminalStatus: 'failed', modelRequestIds, assistantMessageIds, toolCallIds };
          }
        }
      }
      throw new Error(`Turn ${turnId} exceeded ${MAX_TOOL_ROUNDS} model/tool rounds.`);
    } catch (error) {
      this.observeLifecycle({ turnId, stage: 'drive_failed', ...errorDiagnostic(error) });
      try {
        this.observeLifecycle({ turnId, stage: 'failure_terminal_started' });
        await this.failActiveTurn(turnId, error);
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
      return { turnId, terminalStatus: 'failed', modelRequestIds, assistantMessageIds, toolCallIds };
    }
  }

  private async dispatchAndCapture(
    conversationId: string,
    turnId: string,
    modelRequestId: string,
    request: DomainRow
  ): Promise<NormalizedProviderOutput> {
    const providerId = requireText(request.provider_id, 'ModelRequest.provider_id');
    const adapter = await this.providers.resolve(providerId);
    if (adapter.providerId !== providerId) throw new Error(`Provider registry returned ${adapter.providerId} for ${providerId}.`);
    const wrapped: FullRequestProviderAdapter = {
      providerId,
      sendFullRequest: (fullRequest, controls) => adapter.sendFullRequest(fullRequest, {
        signal: controls.signal,
        onEvent: async (event): Promise<StreamEventResult> => {
          this.transientObserver?.observe({
            conversationId,
            turnId,
            modelRequestId,
            event,
            observedAt: this.timestamp()
          });
          return controls.onEvent(event);
        }
      })
    };
    const streamStats = asRecord(request.stream_stats_json);
    const reconnect = reliableDecimal(streamStats?.socketGeneration) > 0n || request.status === 'streaming';
    await this.modelProvider.dispatch(modelRequestId, wrapped, reconnect ? { reconnect: true } : {});
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
    return terminations[0].terminal_status === 'completed' ? 'completed' : 'failed';
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

  private async requireTerminalToolResult(toolCallId: string): Promise<ToolTerminalResult> {
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    if (!terminal) throw new Error(`ToolCall ${toolCallId} has no terminal model result.`);
    return terminal;
  }

  private async terminateIfRequested(
    turnId: string,
    stage: string,
    pendingToolCallId?: string
  ): Promise<boolean> {
    const pendingInputs = await this.list('PendingTurnInput', { turn_id: turnId }, 1000);
    const request = pendingInputs
      .filter((input) => input.state === 'pending' && isTerminationInputKind(input.input_kind))
      .sort((left, right) => compareInteger(left.position, right.position))[0];
    if (!request) return false;

    // Cancellation may race between ModelRequest/ToolCall creation and external dispatch. Close any
    // newly-created provider request and the not-yet-dispatched ToolCall before recording the Turn
    // terminal fact; the TurnControlPlane then atomically releases the exact ExecutionLease.
    await this.modelProvider.cancelTurnDispatches(turnId, `termination request observed at ${stage}`);
    if (pendingToolCallId && !await this.effects.readTerminalResult(pendingToolCallId, false)) {
      await this.effects.settleWithoutEffect({
        source: { kind: 'internal', key: `agent-loop:${turnId}:cancel-tool:${pendingToolCallId}:${request.id}` },
        toolCallId: pendingToolCallId,
        status: 'cancelled',
        detail: { reason: 'turn_termination_requested' }
      });
    }
    await this.turns.terminal({
      source: { kind: 'internal', key: `agent-loop:${turnId}:termination-request:${request.id}` },
      turnId,
      terminalStatus: 'interrupted',
      reason: `Executor observed ${String(request.input_kind)} at ${stage}.`
    });
    return true;
  }

  private async failActiveTurn(turnId: string, error: unknown): Promise<void> {
    const turn = await this.maybeGet('Turn', turnId);
    if (!turn || turn.status !== 'active') return;
    const pendingInputs = await this.list('PendingTurnInput', { turn_id: turnId }, 1000);
    const interrupted = pendingInputs.some((input) =>
      input.state === 'pending' && isTerminationInputKind(input.input_kind)
    );
    const reason = errorMessage(error);
    await this.turns.terminal({
      source: {
        kind: 'internal',
        key: interrupted
          ? `agent-loop:${turnId}:interrupted:${stableDigest(reason)}`
          : `agent-loop:${turnId}:failed:${stableDigest(reason)}`
      },
      turnId,
      terminalStatus: interrupted ? 'interrupted' : 'failed',
      reason
    });
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

  private observeLifecycle(event: Omit<ReliableAgentLifecycleEvent, 'observedAt'>): void {
    if (!this.lifecycleObserver) return;
    try {
      this.lifecycleObserver.observe({ ...event, observedAt: this.timestamp() });
    } catch {
      // Diagnostics must never become a second control path or break the Agent loop.
    }
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

function isTerminationInputKind(value: unknown): boolean {
  return ['interrupt_request', 'interrupt_current_turn', 'termination_request'].includes(String(value));
}

function providerOutputMessage(output: NormalizedProviderOutput): MessageContent {
  return {
    role: 'model',
    parts: [
      ...(output.thought ? [{
        text: output.thought,
        thought: true as const,
        ...(output.thoughtSignature ? { thoughtSignature: output.thoughtSignature } : {})
      }] : []),
      ...(output.text ? [{ text: output.text }] : []),
      ...output.toolCalls.map((call) => ({
        ...(call.providerCallId ? { id: call.providerCallId } : {}),
        functionCall: { name: call.name, args: call.arguments }
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
    toolCalls: normalizeToolCalls(record.toolCalls),
    ...(record.usage !== undefined ? { usage: record.usage } : {})
  };
}

function normalizeToolCalls(value: unknown): NormalizedToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Provider toolCalls must be an array.');
  const normalized: NormalizedToolCall[] = [];
  const byProviderCallId = new Map<string, string>();
  value.forEach((entry, index) => {
    const record = requireRecord(entry as PlainJsonValue, `Provider toolCall ${index}`);
    const name = requireText(record.name, `Provider toolCall ${index}.name`);
    let argumentsValue = record.arguments;
    if (typeof record.argumentsJson === 'string') {
      argumentsValue = normalizePlainJson(JSON.parse(record.argumentsJson), `Provider toolCall ${index}.argumentsJson`);
    }
    const providerCallId = optionalText(record.id);
    const call: NormalizedToolCall = {
      ...(providerCallId ? { providerCallId } : {}),
      name,
      arguments: normalizePlainJson(argumentsValue ?? {}, `Provider toolCall ${index}.arguments`)
    };
    if (providerCallId) {
      const signature = canonicalPlainJson({ name: call.name, arguments: call.arguments }, 'Provider toolCall signature');
      const existing = byProviderCallId.get(providerCallId);
      if (existing !== undefined) {
        if (existing !== signature) throw new Error(`Provider reused tool call id ${providerCallId} with conflicting content.`);
        return;
      }
      byProviderCallId.set(providerCallId, signature);
    }
    normalized.push(call);
  });
  return normalized;
}

function isToolPause(value: ToolTerminalResult | ReliableAgentToolPause): value is ReliableAgentToolPause {
  return 'disposition' in value && value.disposition === 'paused';
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
