import type { MessageContent } from '../../../shared/protocol';
import {
  ReliableKernelApplication
} from '../../reliableKernel/runtimeApplication';
import type {
  TurnCommandResult,
  TurnContinuationCommand,
  TurnInputCommand,
  TurnRetryCommand
} from '../../reliableKernel/turnControlPlane';

const DEFAULT_LEASE_DURATION_MS = 15 * 60_000;

export type ReliableConversationRunnerErrorHandler = (
  error: unknown,
  context: { operation: 'drive' | 'admit-next'; conversationId: string; turnId?: string }
) => void;

/**
 * Product-side admission/drive coordinator. Durable ordering remains TurnIntent + ExecutionLease in
 * SQLite; this class only wakes the relevant Agent loop and drains the next frozen queued Intent.
 */
export class ReliableConversationRunner {
  private readonly active = new Map<string, Promise<void>>();
  private disposed = false;

  public constructor(
    private readonly application: ReliableKernelApplication,
    private readonly leaseOwnerId: string,
    private readonly onError: ReliableConversationRunnerErrorHandler = defaultErrorHandler,
    private readonly leaseDurationMs = DEFAULT_LEASE_DURATION_MS
  ) {}

  public async input(input: {
    commandId: string;
    conversationId: string;
    text?: string;
    content?: MessageContent;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    const content = serializeUserContent(input.text, input.content);
    const command: TurnInputCommand = {
      source: { kind: 'command', key: input.commandId },
      ...this.lease(input.conversationId),
      content: content.value,
      contentType: content.contentType
    };
    const result = await this.application.turns.input(command);
    this.wake(result);
    return result;
  }

  public async retry(input: {
    commandId: string;
    conversationId: string;
    sourceTurnId: string;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    const command: TurnRetryCommand = {
      source: { kind: 'command', key: input.commandId },
      ...this.lease(input.conversationId),
      sourceTurnId: input.sourceTurnId
    };
    const result = await this.application.turns.retry(command);
    this.wake(result);
    return result;
  }

  public async continuation(input: {
    commandId: string;
    conversationId: string;
    sourceTurnId: string;
    text?: string;
    content?: MessageContent;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    const content = serializeUserContent(input.text, input.content);
    const command: TurnContinuationCommand = {
      source: { kind: 'command', key: input.commandId },
      ...this.lease(input.conversationId),
      sourceTurnId: input.sourceTurnId,
      content: content.value,
      contentType: content.contentType
    };
    const result = await this.application.turns.continuation(command);
    this.wake(result);
    return result;
  }

  public resume(conversationId: string, turnId: string): void {
    if (this.disposed) return;
    this.scheduleDrive(conversationId, turnId);
  }

  public async interrupt(input: {
    commandId: string;
    conversationId: string;
    turnId: string;
    reason: string;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    const result = await this.application.turns.interrupt({
      source: { kind: 'command', key: input.commandId },
      turnId: input.turnId,
      reason: input.reason
    });
    await this.application.modelProvider.cancelTurnDispatches(input.turnId, input.reason);
    this.scheduleDrive(input.conversationId, input.turnId);
    return result;
  }

  public async waitForIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()]);
  }

  public dispose(): void {
    this.disposed = true;
  }

  private wake(result: TurnCommandResult): void {
    if (result.admitted && result.turnId && result.conversationId) {
      this.scheduleDrive(result.conversationId, result.turnId);
    }
  }

  private scheduleDrive(conversationId: string, turnId: string): void {
    if (this.disposed || this.active.has(turnId)) return;
    const task = this.driveAndDrain(conversationId, turnId)
      .catch((error) => this.onError(error, { operation: 'drive', conversationId, turnId }))
      .finally(() => this.active.delete(turnId));
    this.active.set(turnId, task);
  }

  private async driveAndDrain(conversationId: string, turnId: string): Promise<void> {
    const result = await this.application.agentLoop.drive(turnId);
    if (this.disposed || result.terminalStatus === 'waiting') return;
    let next: TurnCommandResult | null;
    try {
      next = await this.application.turns.admitNextQueued(this.lease(conversationId));
    } catch (error) {
      this.onError(error, { operation: 'admit-next', conversationId, turnId });
      return;
    }
    if (next?.turnId) this.scheduleDrive(conversationId, next.turnId);
  }

  private lease(conversationId: string): {
    conversationId: string;
    leaseOwnerId: string;
    hostBootId: string;
    leaseExpiresAt: string;
  } {
    return {
      conversationId,
      leaseOwnerId: this.leaseOwnerId,
      hostBootId: this.application.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + this.leaseDurationMs).toISOString()
    };
  }

  private requireOpen(): void {
    if (this.disposed) throw new Error('ReliableConversationRunner 已关闭。');
  }
}

function serializeUserContent(text: string | undefined, content: MessageContent | undefined): {
  value: string;
  contentType: string;
} {
  if (content?.parts?.length) {
    return {
      value: JSON.stringify({ role: 'user', parts: content.parts }),
      contentType: 'application/vnd.limcode.message+json'
    };
  }
  const value = text?.trim() ?? '';
  if (!value) throw new TypeError('可靠 Turn 输入不能为空。');
  return { value, contentType: 'text/plain; charset=utf-8' };
}

function defaultErrorHandler(
  error: unknown,
  context: { operation: 'drive' | 'admit-next'; conversationId: string; turnId?: string }
): void {
  console.error('[LimCode] Reliable conversation runner failed.', context, error);
}
