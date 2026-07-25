import type { CleanupHint } from '../../../shared/conversationReliability';
import type { RunId } from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { stableIdFromSeed } from '../stableIdFactory';
import { asJson, type ConversationTransitionBuilder } from './transitionBuilder';
import type { DurableConversationFacts } from './types';
import { isReliableBarrierEffectPayload } from './preflightTypes';
import { isConversationOperationOwner } from './operationOwner';
import { appendTerminalRun, type RunTerminationSpec } from './runTermination';
import { releaseExecutionLease } from './executionLease';
import { collectCompressionBlockDependencyClosure, projectionIdsDependingOnSources } from './modelContextProjection';
import { appendRuntimeCleanupOutbox } from './runtimeCleanup';
import { appendBoundedInlineToolResult, withoutEmbeddedToolResult } from './toolResultArtifacts';

export interface TerminateRunGraphOptions {
  rootRunIds: readonly RunId[];
  termination: RunTerminationSpec;
  cascadeForegroundChildren: boolean;
  /** Explicit tree interruption may also terminate background descendants; normal parent cancel detaches them. */
  cascadeBackgroundChildren?: boolean;
  /** Resolver-proven closure. When supplied, planner traversal must match it exactly or fail closed. */
  expectedClosureRunIds?: readonly RunId[];
}

export interface TerminateRunGraphPlan {
  rootRunIds: RunId[];
  rootTermination: RunTerminationSpec;
  affectedRunIds: RunId[];
  activeAffectedRunIds: RunId[];
  alreadyTerminalRunIds: RunId[];
  cancelledOperationIds: string[];
  invalidatedAttemptIds: string[];
  foregroundChildRunIds: RunId[];
  detachedBackgroundChildRunIds: RunId[];
  cleanupHints: CleanupHint[];
}

export interface AppendTerminateRunGraphMutationOptions {
  /**
   * Delete/retry may remove the streaming model Message in the same transaction while retaining the
   * terminal Request as a stream-fence tombstone. Normal Stop paths leave this empty.
   */
  detachModelMessageRequestIds?: readonly string[];
}

/** Pure closure identity used by the pre-claim dynamic-scope fence. */
export function collectTerminateRunGraphClosureRunIds(
  facts: DurableConversationFacts,
  options: Pick<TerminateRunGraphOptions, 'rootRunIds' | 'cascadeForegroundChildren' | 'cascadeBackgroundChildren'>
): RunId[] {
  const affected = new Set<RunId>();
  const queue = [...options.rootRunIds];
  while (queue.length > 0) {
    const runId = queue.shift();
    if (!runId || affected.has(runId)) continue;
    affected.add(runId);
    for (const link of facts.childTurnLinks.filter((candidate) => candidate.parentTurnId === runId)) {
      if ((link.mode === 'foreground' && options.cascadeForegroundChildren)
        || (link.mode === 'background' && options.cascadeBackgroundChildren === true)) {
        queue.push(link.childTurnId);
      }
    }
  }
  return [...affected].sort();
}

export function planTerminateRunGraph(facts: DurableConversationFacts, options: TerminateRunGraphOptions): TerminateRunGraphPlan {
  const affected = new Set<RunId>();
  const foregroundChildren = new Set<RunId>();
  const detachedBackgroundChildren = new Set<RunId>();
  const queue = [...options.rootRunIds];

  while (queue.length > 0) {
    const runId = queue.shift();
    if (!runId || affected.has(runId)) continue;
    affected.add(runId);
    for (const link of facts.childTurnLinks.filter((candidate) => candidate.parentTurnId === runId)) {
      if (link.mode === 'foreground' && options.cascadeForegroundChildren) {
        foregroundChildren.add(link.childTurnId);
        queue.push(link.childTurnId);
      } else if (link.mode === 'background') {
        if (options.cascadeBackgroundChildren) queue.push(link.childTurnId);
        else detachedBackgroundChildren.add(link.childTurnId);
      }
    }
  }

  if (options.expectedClosureRunIds) {
    assertSameRunSet(affected, options.expectedClosureRunIds, 'Resolved and planned RunGraph closures differ');
  }
  const missingRuns = [...affected].filter((runId) => !facts.turns.some((run) => run.id === runId));
  if (missingRuns.length > 0) {
    throw new Error(`RunGraph closure contains Runs outside the leased facts: ${missingRuns.sort().join(', ')}`);
  }
  const activeAffectedRunIds = facts.turns
    .filter((run) => affected.has(run.id) && run.phase !== 'terminal')
    .map((run) => run.id);
  const alreadyTerminalRunIds = facts.turns
    .filter((run) => affected.has(run.id) && run.phase === 'terminal')
    .map((run) => run.id);

  const cancelledOperations = facts.operations
    .filter((operation) => !isConversationOperationOwner(operation)
      && affected.has(operation.ownerRunId)
      && (operation.state === 'pending' || operation.state === 'running'));
  const operationIds = new Set(cancelledOperations.map((operation) => operation.id));
  const invalidatedAttempts = facts.attempts
    .filter((attempt) => operationIds.has(attempt.operationId) && (attempt.state === 'pending' || attempt.state === 'dispatched'));
  const cleanupHints = cleanupHintsForAttempts(facts, invalidatedAttempts.map((attempt) => attempt.id));

  return {
    rootRunIds: [...new Set(options.rootRunIds)],
    rootTermination: { ...options.termination },
    affectedRunIds: [...affected],
    activeAffectedRunIds,
    alreadyTerminalRunIds,
    cancelledOperationIds: cancelledOperations.map((operation) => operation.id),
    invalidatedAttemptIds: invalidatedAttempts.map((attempt) => attempt.id),
    foregroundChildRunIds: [...foregroundChildren],
    detachedBackgroundChildRunIds: [...detachedBackgroundChildren],
    cleanupHints
  };
}

export function appendTerminateRunGraphMutations(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  plan: TerminateRunGraphPlan,
  now: number,
  options: AppendTerminateRunGraphMutationOptions = {}
): void {
  const affected = new Set(plan.affectedRunIds);
  const cancelledOperations = new Set(plan.cancelledOperationIds);
  const invalidatedAttempts = new Set(plan.invalidatedAttemptIds);
  const detachedChildren = new Set(plan.detachedBackgroundChildRunIds);
  const rootRuns = new Set(plan.rootRunIds);
  const detachedModelMessageRequests = new Set(options.detachModelMessageRequestIds ?? []);
  const terminationByRun = new Map<RunId, RunTerminationSpec>();

  const terminalizedRunIds = new Set<RunId>();
  for (const run of facts.turns.filter((candidate) => affected.has(candidate.id))) {
    if (run.phase === 'terminal') continue;
    const termination = rootRuns.has(run.id)
      ? plan.rootTermination
      : childTermination(facts, affected, run.id);
    terminationByRun.set(run.id, termination);
    appendTerminalRun(builder, run, termination, now);
    terminalizedRunIds.add(run.id);
  }
  assertSameRunSet(terminalizedRunIds, plan.activeAffectedRunIds, 'RunGraph terminal mutations are incomplete');
  appendTerminatedRunCompressionInvalidations(builder, facts, affected, now);
  const affectedInteractionOwners = facts.interactionOwnerLinks.filter((owner) => affected.has(owner.turnId));
  for (const owner of affectedInteractionOwners) {
    const request = facts.interactionRequests.find((candidate) => candidate.id === owner.interactionRequestId);
    if (!request) throw new Error(`Interaction owner ${owner.id} references missing request ${owner.interactionRequestId}.`);
    if (request.state !== 'pending') continue;
    const responseId = stableIdFromSeed(
      'interactionResponse',
      `interaction:${request.id}:${request.revision}:response`
    );
    const responsePayload = asJson({ reason: 'turn_cancelled' });
    builder
      .generatedId(responseId)
      .upsert('interactionRequests', { ...request, state: 'cancelled', updatedAt: now })
      .upsert('interactionResponses', {
        id: responseId,
        interactionRequestId: request.id,
        interactionRevision: request.revision,
        ownerTurnId: owner.turnId,
        decision: 'cancel',
        actor: 'system',
        payload: responsePayload,
        payloadHash: canonicalSha256(responsePayload),
        commandId: `system:terminate:${request.id}:${request.revision}`,
        createdAt: now
      });
  }
  for (const lease of facts.executionLeases.filter((candidate) => candidate.state !== 'released' && affected.has(candidate.turnId))) {
    builder.upsert('executionLeases', releaseExecutionLease(lease, { turnId: lease.turnId, now }));
  }
  builder.removeMany('pauses', facts.pauses.filter((pause) => affected.has(pause.runId)).map((pause) => pause.id));

  for (const operation of facts.operations.filter((candidate) => cancelledOperations.has(candidate.id))) {
    builder.upsert('operations', {
      ...operation,
      state: 'cancelled',
      currentGeneration: operation.currentGeneration + 1,
      rowVersion: operation.rowVersion + 1,
      updatedAt: now,
      completedAt: now
    });
    const descriptor = facts.primaryEffects.find((effect) => effect.operationId === operation.id && effect.generation === operation.currentGeneration);
    const payload = descriptor ? facts.effectPayloads.find((candidate) => candidate.id === descriptor.payloadRef.id) : undefined;
    const barrierPayload = payload?.payload;
    const reasonCode = terminationForOperation(facts, terminationByRun, operation.id, plan.rootTermination).reasonCode;
    if (barrierPayload && isReliableBarrierEffectPayload(barrierPayload)) {
      if (barrierPayload.barrier === 'compression.pre_llm' || barrierPayload.barrier === 'compression.standalone') {
        const block = facts.compressionBlocks.find((candidate) => candidate.id === barrierPayload.plan.block.id && candidate.status === 'running');
        if (block) builder.upsert('compressionBlocks', { ...block, status: 'error', error: reasonCode, updatedAt: now, completedAt: now });
      } else {
        const checkpoint = facts.checkpoints.find((candidate) => candidate.id === barrierPayload.plan.checkpoint.id && candidate.status === 'pending');
        if (checkpoint) builder.upsert('checkpoints', { ...checkpoint, status: 'failed', skipReason: 'io_error', message: reasonCode, updatedAt: now });
      }
    }
  }
  for (const attempt of facts.attempts.filter((candidate) => invalidatedAttempts.has(candidate.id))) {
    builder.upsert('attempts', {
      ...attempt,
      state: 'cancelled',
      rowVersion: attempt.rowVersion + 1,
      completedAt: now
    });
  }

  for (const invocation of facts.invocations.filter((candidate) => affected.has(candidate.runId)
    && candidate.status !== 'complete'
    && candidate.status !== 'error'
    && candidate.status !== 'cancelled'
    && candidate.status !== 'interrupted')) {
    builder.upsert('invocations', {
      ...invocation,
      status: 'cancelled',
      completedAt: now,
      error: terminationByRun.get(invocation.runId)?.reasonCode ?? plan.rootTermination.reasonCode,
      rowVersion: invocation.rowVersion + 1
    });
  }
  for (const request of facts.requests.filter((candidate) => cancelledOperations.has(candidate.operationId))) {
    const { modelMessageId: _detachedModelMessageId, ...requestWithoutModelMessage } = request;
    builder.upsert('requests', {
      ...(detachedModelMessageRequests.has(request.id) ? requestWithoutModelMessage : request),
      state: 'cancelled',
      completedAt: now,
      error: terminationForOperation(facts, terminationByRun, request.operationId, plan.rootTermination).reasonCode,
      rowVersion: request.rowVersion + 1
    });
    const attempt = facts.attempts.find((candidate) => candidate.operationId === request.operationId && invalidatedAttempts.has(candidate.id));
    const checkpoint = attempt
      ? facts.streamCheckpointHeads
        .filter((candidate) => candidate.requestId === request.id && candidate.attemptId === attempt.id && candidate.generation === attempt.generation)
        .sort((left, right) => right.streamSeq - left.streamSeq || right.id.localeCompare(left.id))[0]
      : undefined;
    if (attempt) {
      builder.upsert('terminalStreamFences', {
        id: `stream-fence:${request.id}:${attempt.id}:${attempt.generation}`,
        requestId: request.id,
        attemptId: attempt.id,
        generation: attempt.generation,
        finalStreamSeq: request.streamSeq ?? 0
      });
    }
    for (const head of facts.streamCheckpointHeads.filter((candidate) => candidate.requestId === request.id)) {
      builder.remove('streamCheckpointHeads', head.id);
    }
    if (request.modelMessageId && !detachedModelMessageRequests.has(request.id)) {
      const message = facts.messages.find((candidate) => candidate.id === request.modelMessageId);
      if (message?.status === 'streaming') {
        const content = checkpoint?.resolvedContent
          ? JSON.parse(JSON.stringify(checkpoint.resolvedContent)) as typeof message.content
          : message.content;
        builder.upsert('messages', {
          ...message,
          content,
          status: 'partial'
        });
        if (checkpoint?.resolvedContent) {
          const links = facts.messageCurrentRevisionLinks.filter((link) => link.messageId === message.id);
          if (links.length !== 1) throw new Error(`Interrupted Message ${message.id} has ${links.length} current revision links.`);
          const revision = facts.messageRevisions.find((candidate) => candidate.id === links[0].revisionId);
          if (!revision || revision.messageId !== message.id) throw new Error(`Interrupted Message ${message.id} has no current revision.`);
          builder.upsert('messageRevisions', { ...revision, content });
        }
      }
    }
  }
  for (const execution of facts.toolExecutions.filter((candidate) => cancelledOperations.has(candidate.operationId))) {
    builder.upsert('toolExecutions', { ...execution, state: 'cancelled', rowVersion: execution.rowVersion + 1 });
    const tool = facts.toolCalls.find((candidate) => candidate.id === execution.id);
    if (tool && tool.status !== 'success' && tool.status !== 'warning' && tool.status !== 'error') {
      const reasonCode = terminationForOperation(facts, terminationByRun, execution.operationId, plan.rootTermination).reasonCode;
      appendBoundedInlineToolResult(builder, {
        conversationId: execution.conversationId,
        tool,
        status: 'error',
        result: { ok: false, interrupted: true, reasonCode },
        now,
        error: reasonCode
      });
      builder.upsert('toolCalls', {
        ...withoutEmbeddedToolResult(tool),
        status: 'error',
        error: reasonCode,
        updatedAt: now
      });
    }
  }
  const detachedBridgeIds = new Set(facts.childTurnLinks
    .filter((child) => detachedChildren.has(child.childTurnId) && child.mode === 'background')
    .map((child) => child.answerBridgeId));
  const affectedBridgeIds = new Set(facts.childTurnLinks
    .filter((child) => affected.has(child.parentTurnId) || affected.has(child.childTurnId))
    .map((child) => child.answerBridgeId));
  for (const bridge of facts.answerBridges.filter((candidate) => candidate.lifecycle === 'open'
    && !detachedBridgeIds.has(candidate.id)
    && (affected.has(candidate.ownerRunId) || affectedBridgeIds.has(candidate.id)))) {
    builder.upsert('answerBridges', {
      ...bridge,
      lifecycle: 'cancelled',
      rowVersion: bridge.rowVersion + 1
    });
  }
  for (const child of facts.childTurnLinks.filter((candidate) => candidate.mode !== 'detached'
    && (detachedChildren.has(candidate.childTurnId)
      || affected.has(candidate.parentTurnId)
      || affected.has(candidate.childTurnId)))) {
    const { foregroundDeadlineAt: _foregroundDeadlineAt, ...detachedChild } = child;
    builder.upsert('childTurnLinks', {
      ...detachedChild,
      mode: 'detached',
      completionPolicy: detachedBridgeIds.has(child.answerBridgeId) ? 'inject_current_or_continue' : 'notify_only',
      detachedAt: now,
      detachedReason: plan.rootTermination.reasonCode,
      rowVersion: child.rowVersion + 1
    });
  }
  for (const delivery of facts.runtimeDeliveryLinks.filter((candidate) => candidate.state === 'pending'
    && candidate.ownerTurnId !== undefined
    && affected.has(candidate.ownerTurnId)
    && !runtimeDeliveryBelongsToDetachedBridge(facts, candidate.inboxItemId, detachedBridgeIds))) {
    builder.upsert('runtimeDeliveryLinks', {
      ...delivery,
      state: 'dead_letter',
      error: plan.rootTermination.reasonCode,
      deadLetterAt: now,
      rowVersion: delivery.rowVersion + 1,
      updatedAt: now
    });
  }
  appendRuntimeCleanupOutbox(builder, facts, plan.invalidatedAttemptIds, now);
  for (const hint of plan.cleanupHints) builder.cleanupHint(hint);
}

function appendTerminatedRunCompressionInvalidations(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  affectedRunIds: ReadonlySet<RunId>,
  now: number
): void {
  const messageIds = new Set<string>(facts.messageTurnLinks
    .filter((link) => affectedRunIds.has(link.turnId))
    .map((link) => link.messageId));
  const toolIds = new Set<string>(facts.toolRunLinks
    .filter((link) => affectedRunIds.has(link.runId))
    .map((link) => link.toolCallId));
  const projectionIds = projectionIdsDependingOnSources(facts, (source) =>
    (source.sourceKind === 'messageRevision' && !!source.messageId && messageIds.has(source.messageId))
    || (source.sourceKind === 'toolCall' && toolIds.has(source.sourceId))
    || (source.sourceKind === 'runTermination' && !!source.runId && affectedRunIds.has(source.runId as RunId)));
  const seeds = new Set(facts.compressionBlockSourceLinks
    .filter((link) => link.sourceKind === 'message' && messageIds.has(link.sourceId))
    .map((link) => link.blockId));
  for (const link of facts.compressionModelContextProjectionLinks) {
    if (projectionIds.has(link.projectionId)) seeds.add(link.blockId);
  }
  const staleBlockIds = collectCompressionBlockDependencyClosure(facts, seeds);
  for (const block of facts.compressionBlocks.filter((candidate) => staleBlockIds.has(candidate.id) && candidate.status === 'complete')) {
    builder.upsert('compressionBlocks', {
      ...block,
      status: 'stale',
      staleReason: 'source_run_terminated',
      updatedAt: now
    });
  }
}

function runtimeDeliveryBelongsToDetachedBridge(
  facts: DurableConversationFacts,
  inboxItemId: string,
  detachedBridgeIds: ReadonlySet<string>
): boolean {
  const item = facts.runtimeInboxItems.find((candidate) => candidate.id === inboxItemId);
  const payload = item?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const bridgeId = (payload as Record<string, unknown>).bridgeId;
  return typeof bridgeId === 'string' && detachedBridgeIds.has(bridgeId);
}

function childTermination(
  facts: DurableConversationFacts,
  affected: ReadonlySet<RunId>,
  childRunId: RunId
): RunTerminationSpec {
  const parents = facts.childTurnLinks.filter((link) => link.childTurnId === childRunId && affected.has(link.parentTurnId));
  if (parents.length !== 1) {
    throw new Error(`Affected child Run ${childRunId} has ${parents.length} terminating parents.`);
  }
  return {
    kind: 'interrupted',
    actor: 'parent_run',
    reasonCode: 'parent_run_terminated',
    triggerRunId: parents[0].parentTurnId
  };
}

function terminationForOperation(
  facts: DurableConversationFacts,
  byRun: ReadonlyMap<RunId, RunTerminationSpec>,
  operationId: string,
  fallback: RunTerminationSpec
): RunTerminationSpec {
  const operation = facts.operations.find((candidate) => candidate.id === operationId);
  if (!operation || isConversationOperationOwner(operation)) return fallback;
  return byRun.get(operation.ownerRunId) ?? fallback;
}

function assertSameRunSet(actual: ReadonlySet<RunId>, expectedValues: readonly RunId[], label: string): void {
  const expected = new Set(expectedValues);
  const missing = [...expected].filter((runId) => !actual.has(runId));
  const unexpected = [...actual].filter((runId) => !expected.has(runId));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`${label}; missing=[${missing.sort().join(', ')}], unexpected=[${unexpected.sort().join(', ')}].`);
  }
}

export function cleanupHintsForAttempts(facts: DurableConversationFacts, attemptIds: readonly string[]): CleanupHint[] {
  const wanted = new Set(attemptIds);
  const effects = facts.primaryEffects.filter((effect) => wanted.has(effect.attemptId));
  return effects.flatMap((effect): CleanupHint[] => {
    if (effect.kind === 'llm.request' || effect.kind.startsWith('compression.')) {
      return [{ kind: 'llm_abort', conversationId: effect.conversationId, ownerId: effect.attemptId }];
    }
    if (effect.kind.startsWith('tool.')) {
      return [{ kind: 'tool_abort', conversationId: effect.conversationId, ownerId: effect.attemptId }];
    }
    return [];
  });
}
