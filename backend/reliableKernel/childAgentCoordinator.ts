import type {
  ReliableAgentLoop,
  ReliableAgentLoopResult,
  ReliableAgentToolDispatchInput
} from './agentLoop';
import type { AnswerControlPlane, RuntimeDeliveryControlPlane } from './answerDelivery';
import type { ChildExecutionControlPlane, ChildExecutionSnapshot } from './childExecution';
import type { EffectControlPlane, ToolTerminalResult } from './effectControlPlane';
import type { ModelProviderControlPlane } from './modelProviderControlPlane';
import { stablePhaseFId } from './phaseFIdentity';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

export interface ReliableChildAgentSelection {
  agentId: string;
  agentType: string;
  title?: string;
}

export interface ReliableChildAgentSelector {
  resolve(input: { agentId?: string; agentType?: string }): Promise<ReliableChildAgentSelection>;
}

export interface ReliableChildAgentCoordinatorDependencies {
  database: RuntimeDatabase;
  effects: EffectControlPlane;
  children: ChildExecutionControlPlane;
  answers: AnswerControlPlane;
  deliveries: RuntimeDeliveryControlPlane;
  modelProvider: ModelProviderControlPlane;
  agentLoop: ReliableAgentLoop;
  agents: ReliableChildAgentSelector;
  now?: () => string;
}

/**
 * Product orchestration for run_agent and AnswerBridge tools. Durable lifecycle facts stay in their
 * dedicated control planes; this coordinator only orders local dispatch, waiting and re-entry.
 */
export class ReliableChildAgentCoordinator {
  private readonly activeTurns = new Map<string, Promise<ReliableAgentLoopResult>>();
  private readonly now: () => string;
  private disposing = false;
  private disposePromise: Promise<void> | undefined;

  public constructor(private readonly dependencies: ReliableChildAgentCoordinatorDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async dispatch(input: ReliableAgentToolDispatchInput): Promise<ToolTerminalResult | undefined> {
    switch (input.toolName) {
      case 'run_agent':
        return this.runAgent(input);
      case 'submit_agent_answer':
        return this.submitAnswer(input);
      case 'read_agent_answer':
        return this.readAnswer(input);
      default:
        return undefined;
    }
  }

  /** Waits for currently launched child Turns and any tasks they launch before returning. */
  public async waitForIdle(): Promise<void> {
    for (;;) {
      const active = [...this.activeTurns.values()];
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  /** Stops new launches, aborts per-child Provider dispatches, then drains local Turn tasks. */
  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    this.disposePromise = (async () => {
      const activeTurnIds = [...this.activeTurns.keys()];
      await Promise.allSettled(activeTurnIds.map((turnId) =>
        this.dependencies.modelProvider.cancelTurnDispatches(turnId, 'child coordinator disposing')
      ));
      await this.waitForIdle();
    })();
    return this.disposePromise;
  }

  private async runAgent(input: ReliableAgentToolDispatchInput): Promise<ToolTerminalResult> {
    const args = requireRecord(input.arguments, 'run_agent arguments');
    const mode = optionalText(args.mode) || 'run';
    if (mode === 'interrupt') return this.interruptChild(input, args);
    if (mode !== 'run') throw new Error(`Unsupported run_agent mode: ${mode}.`);
    const prompt = requireText(args.prompt, 'run_agent.prompt');
    const foregroundWaitMs = requireWaitMs(args.foregroundWaitMs);
    const answerBridgeId = optionalText(args.answerBridgeId);
    return answerBridgeId
      ? this.continueChild(input, answerBridgeId, prompt, foregroundWaitMs)
      : this.spawnChild(input, args, prompt, foregroundWaitMs);
  }

  private async spawnChild(
    input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue },
    prompt: string,
    foregroundWaitMs: number
  ): Promise<ToolTerminalResult> {
    const agentArgs = optionalRecord(args.agent);
    const selection = await this.dependencies.agents.resolve({
      ...(optionalText(agentArgs?.id) ? { agentId: optionalText(agentArgs?.id) } : {}),
      ...(optionalText(agentArgs?.type) ? { agentType: optionalText(agentArgs?.type) } : {})
    });
    const answerBridgeId = stablePhaseFId('answer_bridge', input.toolCallId);
    const completionPolicy = foregroundWaitMs === 0 ? 'background' as const : 'wait_for_answer' as const;
    const deadline = completionPolicy === 'wait_for_answer'
      ? new Date(Date.parse(this.timestamp()) + foregroundWaitMs).toISOString()
      : undefined;
    const spawned = await this.dependencies.children.spawn({
      sourceToolCallId: input.toolCallId,
      childAgentId: selection.agentId,
      prompt: promptWithAnswerBridge(prompt, answerBridgeId),
      completionPolicy,
      ...(deadline ? { waitDeadlineAt: deadline } : {}),
      ...(selection.title ? { title: selection.title } : {}),
      leaseOwnerId: `child:${input.toolCallId}`,
      leaseExpiresAt: leaseExpiry(this.timestamp(), foregroundWaitMs)
    });
    if (spawned.answerBridgeId !== answerBridgeId) {
      throw new Error('ChildExecution returned an unexpected AnswerBridge identity.');
    }
    const claimed = await this.dependencies.children.claimSpawnDispatch(spawned.effectIntentId);
    if (!claimed) {
      const replay = await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
      if (replay) return replay;
      throw new Error(`subagent_spawn ${spawned.effectIntentId} was already claimed without a terminal Tool result.`);
    }
    const receipt = await this.dependencies.children.recordSpawnReceipt({
      sourceKey: `local-child-spawn:${spawned.attemptId}`,
      attemptId: spawned.attemptId,
      outcome: 'succeeded',
      detail: { adapter: 'reliable-local-agent-loop' }
    });
    await this.dependencies.children.reconcileSpawnReceipt(receipt.effectReceiptId);
    this.launch(spawned.childExecutionId, spawned.childTurnId);
    if (completionPolicy === 'background') return this.requireTerminal(input.toolCallId);
    return this.waitInitialForeground(input.toolCallId, spawned.childExecutionId, deadline!);
  }

  private async continueChild(
    input: ReliableAgentToolDispatchInput,
    answerBridgeId: string,
    prompt: string,
    foregroundWaitMs: number
  ): Promise<ToolTerminalResult> {
    const snapshot = await this.snapshotForBridge(answerBridgeId);
    const activeTurnId = snapshot.activeTurn?.status === 'active'
      ? requireId(snapshot.activeTurn.id, 'Child active Turn.id')
      : undefined;
    const completionPolicy = foregroundWaitMs === 0 ? 'background' as const : 'wait_for_answer' as const;
    const deadline = completionPolicy === 'wait_for_answer'
      ? new Date(Date.parse(this.timestamp()) + foregroundWaitMs).toISOString()
      : undefined;
    const sent = await this.dependencies.children.send({
      sourceKey: `run-agent-continuation:${input.toolCallId}`,
      sourceToolCallId: input.toolCallId,
      childExecutionId: requireId(snapshot.childExecution.id, 'ChildExecution.id'),
      mode: activeTurnId ? 'interrupt_current_turn' : 'queue_next_turn',
      content: promptWithAnswerBridge(prompt, answerBridgeId),
      completionPolicy,
      ...(deadline ? { waitDeadlineAt: deadline } : {})
    });

    if (activeTurnId) {
      await this.dependencies.modelProvider.cancelTurnDispatches(
        activeTurnId,
        'run_agent continuation interrupted current child Turn'
      );
      await this.awaitTurnTask(activeTurnId);
      const latest = await this.dependencies.children.readExecutionSnapshot(
        requireId(snapshot.childExecution.id, 'ChildExecution.id')
      );
      if (latest.activeTurn?.id === activeTurnId && latest.activeTurn.status === 'terminated') {
        await this.dependencies.children.observeTurnTerminal(
          requireId(snapshot.childExecution.id, 'ChildExecution.id'),
          activeTurnId
        );
      }
    }

    const admitted = await this.dependencies.children.admitQueuedIntent({
      sourceKey: `run-agent-continuation-admit:${input.toolCallId}`,
      childExecutionId: requireId(snapshot.childExecution.id, 'ChildExecution.id'),
      turnIntentId: sent.turnIntentId,
      leaseOwnerId: `child-continuation:${input.toolCallId}`,
      leaseExpiresAt: leaseExpiry(this.timestamp(), foregroundWaitMs)
    });
    this.launch(admitted.childExecutionId, admitted.turnId);
    if (completionPolicy === 'background') return this.requireTerminal(input.toolCallId);
    return this.waitContinuationForeground(input.toolCallId, answerBridgeId, deadline!);
  }

  private async interruptChild(
    input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue }
  ): Promise<ToolTerminalResult> {
    const answerBridgeId = requireText(args.answerBridgeId, 'run_agent.answerBridgeId');
    const snapshot = await this.snapshotForBridge(answerBridgeId);
    const cancelled = await this.dependencies.children.cancelSubtree({
      sourceKey: `run-agent-interrupt:${input.toolCallId}`,
      childExecutionId: requireId(snapshot.childExecution.id, 'ChildExecution.id'),
      reason: 'run_agent interrupt requested'
    });
    await Promise.all(cancelled.activeTurnIds.map((turnId) =>
      this.dependencies.modelProvider.cancelTurnDispatches(turnId, 'run_agent interrupt requested')
    ));
    return this.settleOwnTool(input.toolCallId, {
      ok: true,
      status: 'interrupt_committed',
      answerBridgeId,
      childExecutionId: cancelled.rootChildExecutionId,
      activeTurnIds: cancelled.activeTurnIds,
      cancelledIntentIds: cancelled.cancelledIntentIds
    }, `run-agent-interrupt:${input.toolCallId}`);
  }

  private async submitAnswer(input: ReliableAgentToolDispatchInput): Promise<ToolTerminalResult> {
    const args = requireRecord(input.arguments, 'submit_agent_answer arguments');
    const explicitBridgeId = optionalText(args.answerBridgeId);
    const answerBridgeId = explicitBridgeId || await this.defaultAnswerBridgeForTurn(input.turnId);
    const title = requireText(args.title, 'submit_agent_answer.title');
    const content = requireText(args.content, 'submit_agent_answer.content');
    const submissionId = stablePhaseFId('answer_submission', input.toolCallId, answerBridgeId);
    const submitted = await this.dependencies.answers.submit({
      answerBridgeId,
      submissionId,
      sourceTurnId: input.turnId,
      title,
      content,
      contentType: 'text/plain'
    });
    const answerDetail = {
      ok: true,
      answerBridgeId,
      title,
      content,
      submissionId
    };
    const continuationSettlements = await this.dependencies.children.settleContinuationWaits({
      answerBridgeId,
      detail: answerDetail,
      sourceIdentity: `answer:${submissionId}`,
      observedAt: this.timestamp()
    });
    if (!submitted.foregroundSettled && continuationSettlements.length === 0) {
      await this.deliverBackgroundAnswer(answerBridgeId, submitted.inboxItemId);
    }
    return this.settleOwnTool(
      input.toolCallId,
      answerDetail,
      `submit-agent-answer:${submissionId}`
    );
  }

  private async readAnswer(input: ReliableAgentToolDispatchInput): Promise<ToolTerminalResult> {
    const args = requireRecord(input.arguments, 'read_agent_answer arguments');
    const answerBridgeId = requireText(args.answerBridgeId, 'read_agent_answer.answerBridgeId');
    const answer = await this.dependencies.answers.readCurrent(answerBridgeId);
    const detail = answer.status === 'submitted'
      ? {
          ok: true,
          answerBridgeId,
          title: answer.title,
          content: answer.content,
          submissionId: answer.submissionId,
          interrupted: answer.interrupted
        }
      : answer.status === 'running'
        ? { ok: false, status: 'running', error: '对应子 Agent 仍在运行，尚未提交回答。', answerBridgeId }
        : answer.status === 'interrupted'
          ? { ok: false, status: 'interrupted', error: '对应子 Agent 当前没有活动 Turn，也没有已提交回答。', answerBridgeId }
          : { ok: false, status: 'not_found', error: '未找到对应的 AnswerBridge。', answerBridgeId };
    return this.settleOwnTool(input.toolCallId, detail, `read-agent-answer:${input.toolCallId}`);
  }

  private launch(childExecutionId: string, turnId: string): void {
    if (this.disposing) throw new Error('ReliableChildAgentCoordinator is disposing.');
    if (this.activeTurns.has(turnId)) return;
    const task = this.driveChild(childExecutionId, turnId);
    this.activeTurns.set(turnId, task);
    void task.finally(() => {
      if (this.activeTurns.get(turnId) === task) this.activeTurns.delete(turnId);
    }).catch(() => undefined);
  }

  private async driveChild(childExecutionId: string, turnId: string): Promise<ReliableAgentLoopResult> {
    const result = await this.dependencies.agentLoop.drive(turnId);
    if (result.terminalStatus !== 'waiting') {
      const snapshot = await this.dependencies.children.readExecutionSnapshot(childExecutionId);
      if (snapshot.activeTurn?.id === turnId && snapshot.activeTurn.status === 'terminated') {
        await this.dependencies.children.observeTurnTerminal(childExecutionId, turnId);
      }
    }
    return result;
  }

  private async awaitTurnTask(turnId: string): Promise<void> {
    const task = this.activeTurns.get(turnId);
    if (task) {
      await task;
      return;
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const turn = await this.get('Turn', turnId);
      if (!turn || turn.status === 'terminated') return;
      await delay(25);
    }
    throw new Error(`Timed out waiting for child Turn ${turnId} to terminate.`);
  }

  private async waitInitialForeground(
    toolCallId: string,
    childExecutionId: string,
    deadline: string
  ): Promise<ToolTerminalResult> {
    for (;;) {
      const terminal = await this.dependencies.effects.readTerminalResult(toolCallId, false);
      if (terminal) return terminal;
      const remaining = Date.parse(deadline) - Date.now();
      if (remaining <= 0) break;
      const snapshot = await this.dependencies.children.wait(childExecutionId, Math.min(remaining, 1_000));
      if (snapshot.currentSubmission) continue;
      if (!snapshot.activeTurn || snapshot.activeTurn.status === 'terminated') {
        await delay(Math.min(50, remaining));
      }
    }
    await this.dependencies.children.settleForegroundTimeout(childExecutionId, this.timestamp());
    return this.requireTerminal(toolCallId);
  }

  private async waitContinuationForeground(
    toolCallId: string,
    answerBridgeId: string,
    deadline: string
  ): Promise<ToolTerminalResult> {
    for (;;) {
      const terminal = await this.dependencies.effects.readTerminalResult(toolCallId, false);
      if (terminal) return terminal;
      const remaining = Date.parse(deadline) - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(50, remaining));
    }
    await this.dependencies.children.settleContinuationWaits({
      answerBridgeId,
      detail: { timeout: true },
      sourceIdentity: `foreground-timeout:${toolCallId}:${deadline}`,
      observedAt: this.timestamp()
    });
    return this.requireTerminal(toolCallId);
  }

  private async deliverBackgroundAnswer(answerBridgeId: string, inboxItemId: string): Promise<void> {
    const snapshot = await this.snapshotForBridge(answerBridgeId);
    const parentTurnId = requireId(snapshot.parentLink.parent_turn_id, 'ChildExecutionParentLink.parent_turn_id');
    const parentTurn = await this.get('Turn', parentTurnId);
    if (!parentTurn) return;
    const targetConversationId = requireId(parentTurn.conversation_id, 'Parent Turn.conversation_id');
    const active = parentTurn.status === 'active';
    const delivery = await this.dependencies.deliveries.create({
      inboxItemId,
      targetConversationId,
      targetTurnId: active ? parentTurnId : null,
      phase: active ? 'current_turn' : 'notify_only'
    });
    if (active) await this.dependencies.deliveries.advance(requireId(delivery.delivery.id, 'RuntimeDelivery.id'));
  }

  private async defaultAnswerBridgeForTurn(turnId: string): Promise<string> {
    const memberships = await this.list('ChildExecutionTurnLink', { turn_id: turnId }, 2);
    if (memberships.length !== 1) {
      throw new Error('submit_agent_answer 未提供 answerBridgeId，且当前 Turn 不属于唯一 ChildExecution。');
    }
    const bridges = await this.list('AnswerBridge', {
      child_execution_id: requireId(memberships[0].child_execution_id, 'ChildExecutionTurnLink.child_execution_id')
    }, 2);
    if (bridges.length !== 1) throw new Error('ChildExecution 必须拥有唯一 AnswerBridge。');
    return requireId(bridges[0].id, 'AnswerBridge.id');
  }

  private async snapshotForBridge(answerBridgeId: string): Promise<ChildExecutionSnapshot> {
    const bridge = await this.get('AnswerBridge', requireId(answerBridgeId, 'answerBridgeId'));
    if (!bridge) throw new Error(`未找到 answerBridgeId：${answerBridgeId}`);
    return this.dependencies.children.readExecutionSnapshot(
      requireId(bridge.child_execution_id, 'AnswerBridge.child_execution_id')
    );
  }

  private async settleOwnTool(toolCallId: string, detail: unknown, sourceKey: string): Promise<ToolTerminalResult> {
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: sourceKey },
      toolCallId,
      status: 'succeeded',
      detail
    });
    return settled.terminal ?? this.requireTerminal(toolCallId);
  }

  private async requireTerminal(toolCallId: string): Promise<ToolTerminalResult> {
    const terminal = await this.dependencies.effects.readTerminalResult(toolCallId, true);
    if (!terminal) throw new Error(`ToolCall ${toolCallId} has no terminal ToolModelResult.`);
    return terminal;
  }

  private async get(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.dependencies.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return snapshot.snapshot[0] as DomainRow | null;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.dependencies.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    if (!Array.isArray(snapshot.snapshot[0])) throw new TypeError(`${domain} list did not return rows.`);
    return snapshot.snapshot[0];
  }

  private timestamp(): string {
    const value = this.now();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('Coordinator clock must return ISO time.');
    return value;
  }
}

function promptWithAnswerBridge(prompt: string, answerBridgeId: string): string {
  return `${prompt}\n\n[Agent answer bridge]\n本次任务的默认 answerBridgeId 为 ${answerBridgeId}。需要提交阶段性结论或最终正文时调用 submit_agent_answer({ title, content })；继续同一子对话时该默认值保持不变。`;
}

function leaseExpiry(now: string, foregroundWaitMs: number): string {
  return new Date(Date.parse(now) + Math.max(3_600_000, foregroundWaitMs + 60_000)).toISOString();
}

function requireWaitMs(value: PlainJsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 86_400_000) {
    throw new TypeError('run_agent.foregroundWaitMs 必须是 0 到 86400000 的整数毫秒数。');
  }
  return value;
}

function requireRecord(value: PlainJsonValue | undefined, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function optionalRecord(value: PlainJsonValue | undefined): { [key: string]: PlainJsonValue } | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function requireText(value: PlainJsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function optionalText(value: PlainJsonValue | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
