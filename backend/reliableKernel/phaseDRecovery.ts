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
  private readonly handlers: ReadonlyMap<PhaseDRecoveryId, () => Promise<PhaseDRecoveryResult>>;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly effects: EffectControlPlane,
    private readonly files: FileChangeControlPlane,
    private readonly processes: ProcessControlPlane,
    private readonly mcp: McpEffectDispatcher,
    private readonly resolveWorkEnvironment: WorkEnvironmentBoundaryResolver,
    private readonly turns: TurnControlPlane
  ) {
    this.handlers = new Map<PhaseDRecoveryId, () => Promise<PhaseDRecoveryResult>>([
      [PHASE_D_RECOVERY_EFFECT_INTENT_HANGING, () => this.scanHangingEffects()],
      [PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED, () => this.scanUnresolvedFileChanges()]
    ]);
  }

  public ids(): PhaseDRecoveryId[] {
    return [...this.handlers.keys()];
  }

  public async run(id: PhaseDRecoveryId): Promise<PhaseDRecoveryResult> {
    const handler = this.handlers.get(id);
    if (!handler) throw new Error(`Phase D does not own recovery scan ${String(id)}.`);
    return handler();
  }

  public async runAll(): Promise<PhaseDRecoveryResult[]> {
    await this.reconcileCommittedFacts();
    const results = [
      await this.run(PHASE_D_RECOVERY_EFFECT_INTENT_HANGING),
      await this.run(PHASE_D_RECOVERY_FILE_CHANGE_UNRESOLVED)
    ];
    await this.reconcileCommittedFacts();
    return results;
  }

  /** Deterministic DB-only continuation; it is not a registered recovery stable ID. */
  public async reconcileCommittedFacts(): Promise<{ receipts: number; toolResults: number }> {
    let receipts = 0;
    let toolResults = 0;
    const receiptWritten = await listAllDomainRows(this.database, 'EffectIntent', { dispatch_state: 'receipt_written' });
    for (const intent of receiptWritten) {
      const rows = await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2);
      if (rows.length !== 1) throw new Error(`receipt_written EffectIntent ${String(intent.id)} must have one EffectReceipt.`);
      const result = await this.resumePersistedReceipt(intent, rows[0]);
      if (result !== undefined) receipts += 1;
    }
    const activeTurns = await listAllDomainRows(this.database, 'Turn', { status: 'active' });
    for (const turn of activeTurns) {
      toolResults += (await this.effects.finalizeReadyInOrder(String(turn.id))).length;
    }
    return { receipts, toolResults };
  }

  private async scanHangingEffects(): Promise<PhaseDRecoveryResult> {
    const terminal = new Set<string>();
    let scanned = 0;
    let reconciled = 0;
    let unknown = 0;

    const intents = await listAllDomainRows(this.database, 'EffectIntent', { dispatch_state: 'dispatched' });
    scanned += intents.length;
    for (const intent of intents) {
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
    }

    return {
      id: PHASE_D_RECOVERY_EFFECT_INTENT_HANGING,
      scanned,
      reconciled,
      unknown,
      terminalToolCallIds: [...terminal]
    };
  }

  private async resumePersistedReceipt(
    intent: DomainRow,
    receipt: DomainRow
  ): Promise<ToolTerminalResult | null | undefined> {
    const attempts = await this.list('Attempt', { id: intent.attempt_id }, 1);
    if (attempts.length !== 1) throw new Error(`EffectIntent ${String(intent.id)} has no Attempt.`);
    const operations = await this.list('Operation', { id: attempts[0].operation_id }, 1);
    if (operations.length !== 1) throw new Error(`Attempt ${String(attempts[0].id)} has no Operation.`);
    const operation = operations[0];
    if (isTerminalOperationOutcome(operation.status)) {
      if (operation.tool_call_id !== null) {
        const outcomes = await this.list('ToolOutcome', { tool_call_id: operation.tool_call_id }, 1);
        if (outcomes.length === 1) return undefined;
      } else if (intent.effect_kind === 'process_exit') {
        const processReceipts = await this.list('ProcessReceipt', { process_id: operation.owner_id }, 1);
        if (processReceipts.length === 1) return undefined;
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

  private async scanUnresolvedFileChanges(): Promise<PhaseDRecoveryResult> {
    const pending = await listAllDomainRows(this.database, 'FileChangeSet', { status: 'pending' });
    const ordered: Array<{ changeSet: DomainRow; turnId: string; callSeq: bigint }> = [];
    for (const changeSet of pending) {
      const calls = await this.list('ToolCall', { id: changeSet.tool_call_id }, 1);
      if (calls.length !== 1) throw new Error(`Pending FileChangeSet ${String(changeSet.id)} has no ToolCall.`);
      ordered.push({
        changeSet,
        turnId: String(calls[0].turn_id),
        callSeq: requirePositiveBigInt(calls[0].call_seq, 'ToolCall.call_seq')
      });
    }
    ordered.sort((left, right) => left.turnId.localeCompare(right.turnId)
      || (left.callSeq < right.callSeq ? -1 : left.callSeq > right.callSeq ? 1 : 0));
    const terminal = new Set<string>();
    const finalizedRecoveryTurns = new Set<string>();
    let reconciled = 0;
    for (const { changeSet, turnId } of ordered) {
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
