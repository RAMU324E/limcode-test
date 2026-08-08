import {
  EffectControlPlane,
  ToolCallOrderBlockedError,
  type ToolTerminalResult
} from './effectControlPlane';
import { FileChangeControlPlane, type WorkEnvironmentBoundaryResolver } from './fileEffects';
import { McpEffectDispatcher } from './mcpEffects';
import { ProcessControlPlane } from './processEffects';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import { TurnControlPlane } from './turnControlPlane';
import { WorkEnvironmentTransferEffectDispatcher } from './workEnvironmentTransferEffects';

export const PHASE_D_RECOVERY_EFFECT_INTENT_HANGING = 'recovery.effect-intent-hanging';
export const PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED = 'recovery.file-change-unresolved';
export type PhaseDRecoveryId =
  | typeof PHASE_D_RECOVERY_EFFECT_INTENT_HANGING
  | typeof PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED;

export interface PhaseDRecoveryResult {
  id: PhaseDRecoveryId;
  scanned: number;
  reconciled: number;
  unknown: number;
  terminalToolCallIds: string[];
}

function isTerminalOperationOutcome(value: unknown): boolean {
  return ['succeeded', 'failed', 'partial', 'rejected', 'cancelled', 'conflict', 'outcome_unknown'].includes(String(value));
}

function requirePositiveBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n) throw new TypeError(`${label} must be a positive SQLite INTEGER.`);
  return value;
}

function requireOperationOutcome(value: unknown): 'succeeded' | 'failed' | 'partial' | 'cancelled' | 'conflict' | 'outcome_unknown' {
  if (!['succeeded', 'failed', 'partial', 'cancelled', 'conflict', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Invalid persisted operation outcome: ${String(value)}.`);
  }
  return value as 'succeeded' | 'failed' | 'partial' | 'cancelled' | 'conflict' | 'outcome_unknown';
}

/** Minimal registry: exactly the two Phase D-owned scans, not a general recovery rule engine. */
export class PhaseDRecoveryScanner {
  private readonly handlers: ReadonlyMap<PhaseDRecoveryId, (signal?: AbortSignal) => Promise<PhaseDRecoveryResult>>;
  private readonly workEnvironmentTransfers: WorkEnvironmentTransferEffectDispatcher;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly effects: EffectControlPlane,
    private readonly files: FileChangeControlPlane,
    private readonly processes: ProcessControlPlane,
    private readonly mcp: McpEffectDispatcher,
    private readonly resolveWorkEnvironment: WorkEnvironmentBoundaryResolver,
    private readonly turns: TurnControlPlane
  ) {
    this.workEnvironmentTransfers = new WorkEnvironmentTransferEffectDispatcher(database, effects);
    this.handlers = new Map<PhaseDRecoveryId, (signal?: AbortSignal) => Promise<PhaseDRecoveryResult>>([
      [PHASE_D_RECOVERY_EFFECT_INTENT_HANGING, (signal) => this.scanHangingEffects(signal)],
      [PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED, (signal) => this.scanUnresolvedFileChanges(signal)]
    ]);
  }

  public ids(): PhaseDRecoveryId[] {
    return [...this.handlers.keys()];
  }

  public async run(id: PhaseDRecoveryId, signal?: AbortSignal): Promise<PhaseDRecoveryResult> {
    signal?.throwIfAborted();
    const handler = this.handlers.get(id);
    if (!handler) throw new Error(`Phase D does not own recovery scan ${String(id)}.`);
    return handler(signal);
  }

  public async runAll(signal?: AbortSignal): Promise<PhaseDRecoveryResult[]> {
    signal?.throwIfAborted();
    // Close receipts already durable at the scan boundary before dispatched-effect recovery can
    // classify them as missing. A second candidate read below closes receipts racing this pass.
    await this.reconcileReceiptCandidates(signal);
    const results = [
      await this.run(PHASE_D_RECOVERY_EFFECT_INTENT_HANGING, signal),
      await this.run(PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED, signal)
    ];
    await this.reconcileCommittedFacts(signal);
    return results;
  }

  /** Deterministic DB-only continuation; it is not a registered recovery stable ID. */
  public async reconcileCommittedFacts(signal?: AbortSignal): Promise<{
    receipts: number;
    toolResults: number;
    failed: number;
  }> {
    signal?.throwIfAborted();
    const receiptResult = await this.reconcileReceiptCandidates(signal);
    let toolResults = 0;
    let failed = receiptResult.failed;

    const activeTurns = await listAllDomainRows(this.database, 'Turn', { status: 'active' });
    for (const turn of activeTurns) {
      signal?.throwIfAborted();
      try {
        toolResults += (await this.effects.finalizeReadyInOrder(String(turn.id))).length;
      } catch (error) {
        // One malformed/incomplete Turn must not prevent unrelated committed effects from
        // converging. The next local commit or startup pass retries this exact durable frontier.
        console.warn('[reliable-kernel] Turn finalization convergence failed.', String(turn.id), error);
        failed += 1;
      }
    }
    return { receipts: receiptResult.receipts, toolResults, failed };
  }

  private async reconcileReceiptCandidates(signal?: AbortSignal): Promise<{ receipts: number; failed: number }> {
    let receipts = 0;
    let failed = 0;
    const candidates = await this.database.effectReceiptReconciliationCandidates();
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      try {
        const snapshot = await this.database.snapshot([
          DOMAIN_REPOSITORIES.domain('EffectIntent').get(candidate.effectIntentId),
          DOMAIN_REPOSITORIES.domain('EffectReceipt').get(candidate.effectReceiptId)
        ]);
        const intent = snapshot.snapshot[0];
        const receipt = snapshot.snapshot[1];
        if (Array.isArray(intent) || !intent || Array.isArray(receipt) || !receipt) {
          throw new Error(`Effect receipt recovery candidate ${candidate.effectIntentId} lost its immutable facts.`);
        }
        const result = await this.resumePersistedReceipt(intent, receipt);
        if (result !== undefined) receipts += 1;
      } catch (error) {
        // Recovery is a set of independent durable candidates. Continue so one bad process/tool
        // cannot hold every Conversation behind it hostage.
        console.warn(
          '[reliable-kernel] Effect receipt convergence failed.',
          candidate.effectIntentId,
          error
        );
        failed += 1;
      }
    }
    return { receipts, failed };
  }

  private async scanHangingEffects(signal?: AbortSignal): Promise<PhaseDRecoveryResult> {
    const terminal = new Set<string>();
    let scanned = 0;
    let reconciled = 0;
    let unknown = 0;

    const intents = await listAllDomainRows(this.database, 'EffectIntent', { dispatch_state: 'dispatched' });
    scanned += intents.length;
    for (const intent of intents) {
      signal?.throwIfAborted();
      try {
      const receipts = await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2);
      if (receipts.length > 0) {
        if (receipts.length !== 1) throw new Error(`EffectIntent ${String(intent.id)} has multiple EffectReceipts.`);
        const arrived = await this.resumePersistedReceipt(intent, receipts[0]);
        if (arrived !== undefined) {
          reconciled += 1;
          if (arrived === null) {
            if (receipts[0].outcome === 'outcome_unknown') unknown += 1;
          } else {
            if (arrived.status === 'outcome_unknown') unknown += 1;
            terminal.add(arrived.toolCallId);
          }
        }
        continue;
      }
      // Several code-server browser clients may have independent Extension Hosts over the same
      // Runtime root. A newly opened Host must not mistake another live Host's in-flight external
      // effect for crash residue merely because the receipt has not arrived yet. Only the Turn's
      // durable lease plus the lease Host's process identity is accepted as liveness proof; dead or
      // missing owners still fall through to the conservative effect-specific recovery below.
      if (await this.isOwnedByLiveTurnHost(intent)) continue;
      const source = {
        kind: 'recovery' as const,
        key: `recovery:effect-intent-hanging:${intent.id as string}`
      };
      let result: ToolTerminalResult | null;
      switch (intent.effect_kind) {
        case 'file_mutation':
          result = await this.files.recoverDispatchedEffect({
            source,
            effectIntentId: intent.id as string,
            resolver: this.resolveWorkEnvironment
          });
          break;
        case 'process_start':
          result = await this.processes.recoverDispatchedStart({
            source,
            effectIntentId: intent.id as string
          });
          break;
        case 'mcp_tool_call':
          result = await this.mcp.recoverDispatched({
            source,
            effectIntentId: intent.id as string
          });
          break;
        case 'file_transfer':
          result = await this.workEnvironmentTransfers.recoverDispatched({
            source,
            effectIntentId: intent.id as string
          });
          break;
        case 'process_exit': {
          const observed = await this.processes.recoverDispatchedExit({ source, effectIntentId: intent.id as string });
          if (observed.state === 'running') continue;
          if (observed.state === 'outcome_unknown') unknown += 1;
          result = null;
          break;
        }
        case 'process_stop_request':
          result = await this.processes.recoverDispatchedStop({
            source,
            effectIntentId: intent.id as string
          });
          break;
        default:
          // subagent effects belong to Phase F and are deliberately not registered here.
          continue;
      }
      reconciled += 1;
      if (result?.status === 'outcome_unknown') unknown += 1;
      if (result) terminal.add(result.toolCallId);
      } catch (error) {
        signal?.throwIfAborted();
        console.warn('[reliable-kernel] Hanging effect recovery failed.', String(intent.id), error);
      }
    }

    return {
      id: PHASE_D_RECOVERY_EFFECT_INTENT_HANGING,
      scanned,
      reconciled,
      unknown,
      terminalToolCallIds: [...terminal]
    };
  }

  private async isOwnedByLiveTurnHost(intent: DomainRow): Promise<boolean> {
    const dispatchFence = await this.effects.readEffectDispatchFence(String(intent.id));
    if (!dispatchFence) return false;
    const attempts = await this.list('Attempt', { id: intent.attempt_id }, 2);
    if (attempts.length !== 1) return false;
    const operations = await this.list('Operation', { id: attempts[0].operation_id }, 2);
    if (operations.length !== 1 || operations[0].tool_call_id === null) return false;
    if (isTerminalOperationOutcome(operations[0].status)) return false;
    const calls = await this.list('ToolCall', { id: operations[0].tool_call_id }, 2);
    if (calls.length !== 1) return false;
    const turns = await this.list('Turn', { id: calls[0].turn_id, status: 'active' }, 2);
    if (turns.length !== 1) return false;
    const leases = await this.list('ExecutionLease', { turn_id: turns[0].id }, 2);
    if (leases.length !== 1) return false;
    const lease = leases[0];
    if (
      lease.id !== dispatchFence.executionLeaseId
      || lease.conversation_id !== dispatchFence.conversationId
      || lease.turn_id !== dispatchFence.turnId
      || lease.owner_id !== dispatchFence.ownerId
      || lease.host_boot_id !== dispatchFence.hostBootId
      || requirePositiveBigInt(lease.generation, 'ExecutionLease.generation').toString() !== dispatchFence.generation
      || typeof lease.expires_at !== 'string'
      || Date.parse(lease.expires_at) <= Date.now()
    ) return false;
    return this.database.isHostAlive(dispatchFence.hostBootId);
  }

  private async resumePersistedReceipt(
    intent: DomainRow,
    receipt: DomainRow
  ): Promise<ToolTerminalResult | null | undefined> {
    const attempt = (await this.list('Attempt', { id: intent.attempt_id }, 1))[0];
    if (!attempt) throw new Error(`EffectIntent ${String(intent.id)} has no Attempt.`);
    const operation = (await this.list('Operation', { id: attempt.operation_id }, 1))[0];
    if (!operation) throw new Error(`Attempt ${String(attempt.id)} has no Operation.`);
    if (isTerminalOperationOutcome(operation.status)) {
      if (operation.tool_call_id !== null) {
        const outcome = (await this.list('ToolOutcome', { tool_call_id: operation.tool_call_id }, 1))[0];
        if (outcome) return undefined;
      } else if (intent.effect_kind === 'process_exit') {
        const processReceipt = (await this.list('ProcessReceipt', { process_id: operation.owner_id }, 1))[0];
        if (processReceipt) return undefined;
      }
    }
    const effectReceiptId = receipt.id as string;
    switch (intent.effect_kind) {
      case 'file_mutation':
        return this.files.reconcileEffectReceipt(effectReceiptId);
      case 'process_start':
        return this.processes.reconcileStartReceipt(effectReceiptId);
      case 'mcp_tool_call':
        return this.mcp.reconcileEffectReceipt(effectReceiptId, 'recovery');
      case 'file_transfer':
        return this.workEnvironmentTransfers.reconcileEffectReceipt(effectReceiptId, 'recovery');
      case 'process_stop_request':
        return this.effects.completeOperation({
          source: { kind: 'recovery', key: `recovery:process-stop-reconcile:${effectReceiptId}` },
          effectReceiptId,
          outcome: requireOperationOutcome(receipt.outcome)
        });
      case 'process_exit':
        await this.processes.reconcileExitEffectReceipt(effectReceiptId, 'recovery');
        return null;
      default:
        return undefined;
    }
  }

  private async scanUnresolvedFileChanges(signal?: AbortSignal): Promise<PhaseDRecoveryResult> {
    const pending = await listAllDomainRows(this.database, 'FileChangeSet', { status: 'pending' });
    const ordered: Array<{ changeSet: DomainRow; turnId: string; callSeq: bigint }> = [];
    for (const changeSet of pending) {
      signal?.throwIfAborted();
      try {
        const calls = await this.list('ToolCall', { id: changeSet.tool_call_id }, 1);
        if (calls.length !== 1) throw new Error(`Pending FileChangeSet ${String(changeSet.id)} has no ToolCall.`);
        ordered.push({
          changeSet,
          turnId: String(calls[0].turn_id),
          callSeq: requirePositiveBigInt(calls[0].call_seq, 'ToolCall.call_seq')
        });
      } catch (error) {
        signal?.throwIfAborted();
        console.warn('[reliable-kernel] Unresolved file change ordering failed.', String(changeSet.id), error);
      }
    }
    ordered.sort((left, right) => left.turnId.localeCompare(right.turnId)
      || (left.callSeq < right.callSeq ? -1 : left.callSeq > right.callSeq ? 1 : 0));
    const terminal = new Set<string>();
    const finalizedRecoveryTurns = new Set<string>();
    let reconciled = 0;
    for (const { changeSet, turnId } of ordered) {
      signal?.throwIfAborted();
      try {
      const decisions = await this.list('FileChangeDecision', { change_set_id: changeSet.id }, 1);
      if (decisions.length > 0) continue;
      const recovery = await this.turns.recoveryFacts(turnId);
      if (recovery.judgment === 'needs_human') continue;
      if (recovery.judgment === 'finalize' && !recovery.executionLeaseExists) {
        if (!finalizedRecoveryTurns.has(turnId)) {
          await this.turns.finalizeRecovery({
            source: { kind: 'recovery', key: `recovery:turn-finalize:${turnId}` },
            turnId,
            terminalStatus: 'cancelled',
            reason: 'Phase D finalized an unresolved file Turn with no execution lease.'
          });
          finalizedRecoveryTurns.add(turnId);
        }
        const closed = await this.list('FileChangeDecision', { change_set_id: changeSet.id }, 1);
        if (closed.length === 1) {
          reconciled += 1;
          const toolCallId = String(changeSet.tool_call_id);
          const result = await this.effects.readTerminalResult(toolCallId, true);
          if (result) terminal.add(toolCallId);
        }
        continue;
      }
      try {
        const result = await this.files.decide({
          source: {
            kind: 'recovery',
            key: `recovery:file-change-unresolved:${changeSet.id as string}`
          },
          changeSetId: changeSet.id as string,
          decision: 'expired',
          response: { reason: 'Unresolved FileChangeSet expired during Phase D restart scan.' }
        });
        reconciled += 1;
        if (result.terminal) terminal.add(result.terminal.toolCallId);
      } catch (error) {
        if (!(error instanceof ToolCallOrderBlockedError)) throw error;
      }
      } catch (error) {
        signal?.throwIfAborted();
        console.warn('[reliable-kernel] Unresolved file change recovery failed.', String(changeSet.id), error);
      }
    }
    return {
      id: PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED,
      scanned: pending.length,
      reconciled,
      unknown: 0,
      terminalToolCallIds: [...terminal]
    };
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }
}
