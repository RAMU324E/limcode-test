import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import {
  EffectControlPlane,
  preparedContentSteps,
  stablePhaseDId,
  type PhaseDCommandSource,
  type ToolSettlementResult,
  type ToolTerminalResult
} from './effectControlPlane';
import { canonicalPlainJson as canonicalJson, normalizePlainJson } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export interface AskUserPauseResult {
  receiptId: string;
  requestId: string;
  operationId: string;
  pauseId: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface AskUserResolutionResult {
  receiptId: string;
  requestId: string;
  won: boolean;
  deduplicated: boolean;
  terminal?: ToolTerminalResult;
  commitSeq?: string;
}

/** ask_user reuses generic Tool/Interaction/Pause/Resolution facts; there is no AskUser table. */
export class ToolInteractionControlPlane {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly effects: EffectControlPlane,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async pauseForAskUser(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    prompt: unknown;
    waitDeadlineAt?: string | null;
  }): Promise<AskUserPauseResult> {
    const source = normalizeSource(input.source, ['internal'], 'ask-user-pause');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const facts = await this.requireActiveToolFacts(toolCallId);
    if (facts.toolCall.status !== 'pending' || facts.execution.status !== 'pending') {
      throw new Error(`ToolCall ${toolCallId} cannot enter ask_user waiting from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
    }
    const requestId = stablePhaseDId('interaction_request', `ask-user:${toolCallId}`);
    const operationId = stablePhaseDId('operation', `ask-user:${toolCallId}`);
    const pauseId = stablePhaseDId('outcome_pause', operationId);
    const receiptId = sourceReceiptId(source, 'ask-user-pause', toolCallId);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayPause(duplicate, receiptId, requestId, operationId, pauseId);
    const prompt = await this.contentStore.prepare(
      this.database,
      canonicalJson({ toolCallId, prompt: input.prompt }),
      'application/vnd.limcode.ask-user-prompt+json'
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'pending' }),
        ...preparedContentSteps([prompt], 'ask_user_prompt'),
        DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
          id: operationId,
          owner_kind: 'tool_execution',
          owner_id: facts.execution.id,
          tool_call_id: toolCallId,
          status: 'waiting_answer',
          created_at: now,
          updated_at: now
        }, {
          column: 'operation_seq',
          scope: { owner_kind: 'tool_execution', owner_id: facts.execution.id }
        }),
        DOMAIN_REPOSITORIES.domain('OutcomePause').insert({
          id: pauseId,
          operation_id: operationId,
          status: 'waiting',
          reason: 'ask_user',
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').insert({
          id: requestId,
          request_kind: 'ask_user',
          status: 'pending',
          prompt_object_id: prompt.metadata.id,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionOwnerLink').insert({
          id: stablePhaseDId('interaction_owner_link', requestId),
          request_id: requestId,
          turn_id: facts.turn.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionToolCallLink').insert({
          id: stablePhaseDId('interaction_tool_call_link', requestId),
          request_id: requestId,
          tool_call_id: toolCallId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'waiting_answer', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'waiting_answer',
          wait_deadline_at: input.waitDeadlineAt === undefined ? null : input.waitDeadlineAt,
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated) return this.replayPause(committed.receipt, receiptId, requestId, operationId, pauseId);
    return { receiptId, requestId, operationId, pauseId, deduplicated: false, commitSeq: committed.commitSeq };
  }

  public async resolveAskUser(input: {
    source: PhaseDCommandSource;
    requestId: string;
    response: unknown;
    cancelled?: boolean;
  }): Promise<AskUserResolutionResult> {
    const source = normalizeSource(input.source, ['command'], 'ask-user-resolve');
    const requestId = requireId(input.requestId, 'requestId');
    const request = await this.requireExisting('InteractionRequest', requestId);
    if (request.request_kind !== 'ask_user') throw new Error('InteractionRequest is not ask_user.');
    const ownerRows = await this.list('InteractionOwnerLink', { request_id: requestId }, 2);
    if (ownerRows.length !== 1) throw new Error('ask_user InteractionRequest must have one owner link.');
    const turn = await this.requireExisting('Turn', requireId(ownerRows[0].turn_id, 'InteractionOwnerLink.turn_id'));
    const pauseId = stablePhaseDId('outcome_pause', stablePhaseDId('operation', `ask-user:${await this.toolCallIdForRequest(requestId)}`));
    const pause = await this.requireExisting('OutcomePause', pauseId);
    const operation = await this.requireExisting('Operation', requireId(pause.operation_id, 'OutcomePause.operation_id'));
    const toolCallId = requireId(operation.tool_call_id, 'Operation.tool_call_id');
    const status = input.cancelled === true ? 'cancelled' as const : 'succeeded' as const;
    const receiptId = sourceReceiptId(source, 'ask-user-resolve', JSON.stringify([requestId, status]));
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      await this.effects.finalizeReadyInOrder(turn.id as string);
      return this.replayResolution(duplicate, receiptId, requestId);
    }
    const existingResponse = (await this.list('InteractionResponse', { request_id: requestId }, 2))[0];
    if (existingResponse) {
      const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId,
        turnId: turn.id as string,
        steps: []
      });
      await this.effects.finalizeReadyInOrder(turn.id as string);
      return this.lostResolutionResult(committed.receipt, requestId, committed.deduplicated);
    }
    const facts = await this.requireActiveToolFacts(toolCallId);
    if (
      facts.toolCall.status !== 'waiting_answer'
      || facts.execution.status !== 'waiting_answer'
      || operation.status !== 'waiting_answer'
    ) {
      throw new Error(`ToolCall ${toolCallId} is no longer waiting for an ask_user response.`);
    }
    const response = await this.contentStore.prepare(
      this.database,
      canonicalJson({ requestId, sourceReceiptId: receiptId, response: input.response }),
      'application/vnd.limcode.ask-user-response+json'
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      firstResponseRequestId: requestId,
      steps: [
        ...preparedContentSteps([response], 'ask_user_response'),
        // The first-response UNIQUE must linearize before lifecycle assertions so a concurrent
        // loser can replay the winner instead of surfacing a stale-state assertion.
        DOMAIN_REPOSITORIES.domain('InteractionResponse').insert({
          id: stablePhaseDId('interaction_response', requestId),
          request_id: requestId,
          content_object_id: response.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').update(requestId, {
          status,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('OperationResolution').insert({
          id: stablePhaseDId('operation_resolution', pauseId),
          pause_id: pauseId,
          resolution_kind: status,
          content_object_id: response.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('OutcomePause').update(pauseId, {
          status: 'resolved',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operation.id as string, {
          status,
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated) {
      await this.effects.finalizeReadyInOrder(facts.turn.id as string);
      return this.replayResolution(committed.receipt, receiptId, requestId);
    }
    if (committed.firstResponseLost) {
      await this.effects.finalizeReadyInOrder(facts.turn.id as string);
      return this.lostResolutionResult(committed.receipt, requestId, false);
    }
    const finalized = await this.effects.finalizeReadyInOrder(facts.turn.id as string);
    const terminal = finalized.find((entry) => entry.toolCallId === toolCallId)
      ?? await this.effects.readTerminalResult(toolCallId, false);
    return {
      receiptId,
      requestId,
      won: true,
      deduplicated: false,
      commitSeq: committed.commitSeq,
      ...(terminal ? { terminal: { ...terminal, receiptId } } : {})
    };
  }

  /** update_task_list remains structured Tool facts; Phase F will derive its client projection. */
  public async settleTaskList(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    items: unknown[];
  }): Promise<ToolSettlementResult> {
    if (!Array.isArray(input.items)) throw new TypeError('Task list items must be an array.');
    return this.effects.settleWithoutEffect({
      source: input.source,
      toolCallId: input.toolCallId,
      status: 'succeeded',
      detail: { kind: 'task-list', items: input.items.map((item, index) => normalizeTaskListItem(item, index)) }
    });
  }

  private async toolCallIdForRequest(requestId: string): Promise<string> {
    const request = await this.requireExisting('InteractionRequest', requestId);
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(request.prompt_object_id, 'InteractionRequest.prompt_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    const toolCallId = requireId(body.toolCallId, 'ask_user prompt toolCallId');
    if (stablePhaseDId('interaction_request', `ask-user:${toolCallId}`) !== requestId) {
      throw new Error('ask_user prompt does not match InteractionRequest identity.');
    }
    return toolCallId;
  }

  private async replayPause(
    receipt: DomainRow,
    expectedReceiptId: string,
    requestId: string,
    operationId: string,
    pauseId: string
  ): Promise<AskUserPauseResult> {
    assertSourceReceipt(receipt, expectedReceiptId, 'ask-user-pause');
    await this.requireExisting('InteractionRequest', requestId);
    await this.requireExisting('Operation', operationId);
    await this.requireExisting('OutcomePause', pauseId);
    return { receiptId: receipt.id as string, requestId, operationId, pauseId, deduplicated: true };
  }

  private async replayResolution(
    receipt: DomainRow,
    expectedReceiptId: string,
    requestId: string
  ): Promise<AskUserResolutionResult> {
    assertSourceReceipt(receipt, expectedReceiptId, 'ask-user-resolve');
    const toolCallId = await this.toolCallIdForResolvedRequest(requestId);
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    return {
      receiptId: receipt.id as string,
      requestId,
      won: await this.responseReceiptWon(requestId, receipt.id as string),
      deduplicated: true,
      ...(terminal ? { terminal: { ...terminal, receiptId: receipt.id as string } } : {})
    };
  }

  private async lostResolutionResult(
    receipt: DomainRow,
    requestId: string,
    deduplicated: boolean
  ): Promise<AskUserResolutionResult> {
    const toolCallId = await this.toolCallIdForResolvedRequest(requestId);
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    return {
      receiptId: receipt.id as string,
      requestId,
      won: false,
      deduplicated,
      ...(terminal ? { terminal: { ...terminal, receiptId: receipt.id as string } } : {})
    };
  }

  private async toolCallIdForResolvedRequest(requestId: string): Promise<string> {
    const response = (await this.list('InteractionResponse', { request_id: requestId }, 2))[0];
    if (!response) throw new Error('Stable ask_user resolution has no InteractionResponse.');
    return this.toolCallIdForRequest(requestId);
  }

  private async responseReceiptWon(requestId: string, receiptId: string): Promise<boolean> {
    const response = (await this.list('InteractionResponse', { request_id: requestId }, 2))[0];
    if (!response) throw new Error('ask_user resolution has no InteractionResponse.');
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(response.content_object_id, 'InteractionResponse.content_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    return body.sourceReceiptId === receiptId;
  }

  private async requireActiveToolFacts(toolCallId: string): Promise<{
    toolCall: DomainRow;
    execution: DomainRow;
    turn: DomainRow;
    conversation: DomainRow;
    lease: DomainRow;
  }> {
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const executions = await this.list('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executions.length !== 1) throw new Error(`ToolCall ${toolCallId} must have one ToolExecution.`);
    const turn = await this.requireExisting('Turn', requireId(toolCall.turn_id, 'ToolCall.turn_id'));
    const conversation = await this.requireExisting('Conversation', requireId(turn.conversation_id, 'Turn.conversation_id'));
    const leases = await this.list('ExecutionLease', { turn_id: turn.id }, 2);
    if (turn.status !== 'active' || leases.length !== 1) throw new Error('ask_user requires its active Turn ExecutionLease.');
    return { toolCall, execution: executions[0], turn, conversation, lease: leases[0] };
  }

  private async commitSource(options: {
    source: PhaseDCommandSource;
    receiptId: string;
    conversationId: string;
    turnId: string;
    firstResponseRequestId?: string;
    steps: RepositoryTransactionStep[];
  }): Promise<{ receipt: DomainRow; deduplicated: boolean; firstResponseLost?: boolean; commitSeq?: string }> {
    const existing = await this.findSourceReceipt(options.source);
    if (existing) {
      assertSourceReceipt(existing, options.receiptId, 'tool interaction');
      return { receipt: existing, deduplicated: true };
    }
    const receipt = {
      id: options.receiptId,
      source_kind: options.source.kind,
      source_key: options.source.key,
      conversation_id: options.conversationId,
      turn_id: options.turnId,
      created_at: this.timestamp()
    };
    try {
      const committed = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert(receipt),
        ...options.steps
      ]);
      return { receipt, deduplicated: false, commitSeq: committed.commitSeq };
    } catch (error) {
      if (!matchesExpectedUnique(error, [
        ['command_receipt', ['id']],
        ['command_receipt', ['source_kind', 'source_key']],
        ['interaction_response', ['id']],
        ['interaction_response', ['request_id']]
      ])) throw error;
      const racedSource = await this.findSourceReceipt(options.source);
      if (racedSource) {
        assertSourceReceipt(racedSource, options.receiptId, 'tool interaction');
        return { receipt: racedSource, deduplicated: true };
      }
      if (options.firstResponseRequestId) {
        const winner = (await this.list('InteractionResponse', {
          request_id: options.firstResponseRequestId
        }, 2))[0];
        if (winner) {
          const receiptOnly = await this.commitSource({
            source: options.source,
            receiptId: options.receiptId,
            conversationId: options.conversationId,
            turnId: options.turnId,
            steps: []
          });
          return { ...receiptOnly, firstResponseLost: true };
        }
      }
      throw error;
    }
  }

  private async findSourceReceipt(source: PhaseDCommandSource): Promise<DomainRow | undefined> {
    return (await this.list('CommandReceipt', { source_kind: source.kind, source_key: source.key }, 2))[0];
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

function normalizeSource<T extends PhaseDCommandSource['kind']>(
  source: PhaseDCommandSource,
  allowed: readonly T[],
  operation: string
): PhaseDCommandSource & { kind: T } {
  if (!source || !allowed.includes(source.kind as T)) {
    throw new TypeError(`${operation} source kind must be one of: ${allowed.join(', ')}.`);
  }
  return { kind: source.kind as T, key: requireText(source.key, `${operation} source key`) };
}

function sourceReceiptId(source: PhaseDCommandSource, operation: string, scope: string): string {
  return stablePhaseDId('command_receipt', JSON.stringify([source.kind, source.key, operation, scope]));
}

function assertSourceReceipt(receipt: DomainRow, expected: string, operation: string): void {
  if (receipt.id !== expected) throw new Error(`CommandReceipt does not contain ${operation} result facts.`);
}

function matchesExpectedUnique(
  error: unknown,
  expected: ReadonlyArray<readonly [table: string, columns: readonly string[]]>
): boolean {
  const value = error as { code?: unknown; message?: unknown };
  if (
    typeof value.code !== 'string'
    || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(value.code)
    || typeof value.message !== 'string'
  ) return false;
  const marker = 'UNIQUE constraint failed:';
  const index = value.message.indexOf(marker);
  if (index < 0) return false;
  const actual = value.message
    .slice(index + marker.length)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  return expected.some(([table, columns]) => {
    const wanted = columns.map((column) => `${table}.${column}`).sort();
    return wanted.length === actual.length && wanted.every((column, ordinal) => column === actual[ordinal]);
  });
}

function normalizeTaskListItem(value: unknown, index: number): Record<string, unknown> {
  const normalized = normalizePlainJson(value, `taskList.items[${index}]`);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') {
    throw new TypeError(`taskList.items[${index}] must be a plain object.`);
  }
  const record = normalized as Record<string, unknown>;
  const allowed = new Set(['title', 'description', 'status', 'delete']);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`taskList.items[${index}] has unsupported fields: ${unknown.join(', ')}.`);
  if (typeof record.title !== 'string' || record.title.trim().length === 0) {
    throw new TypeError(`taskList.items[${index}].title must be non-empty text.`);
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new TypeError(`taskList.items[${index}].description must be text when present.`);
  }
  if (
    record.status !== undefined
    && !['pending', 'in_progress', 'completed', 'blocked', 'cancelled'].includes(String(record.status))
  ) throw new TypeError(`taskList.items[${index}].status is invalid.`);
  if (record.delete !== undefined && typeof record.delete !== 'boolean') {
    throw new TypeError(`taskList.items[${index}].delete must be boolean when present.`);
  }
  return record;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}
