import type {
  CommandEnvelope,
  CommandPlanningContext,
  CommandRejection,
  ConversationCommandHandler,
  DurableAggregateView,
  DurableViewSpec,
  JsonValue,
  TransitionPlan
} from '../../../shared/conversationReliability';
import type { MessageContent } from '../../../shared/protocol';
import type {
  AuthoritySnapshotId,
  EffectIntentId,
  MessageId,
  MessageRevisionId,
  OperationId,
  AttemptId,
  PendingTurnInputId,
  RelationId,
  RunId,
  TurnIntentId,
  TurnIntentRevisionId
} from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { stableIdFromSeed } from '../stableIdFactory';
import { effectiveConversationExecutionLease } from './executionLease';
import { appendAdmittedTurn } from './turnAdmission';
import { asJson } from './transitionBuilder';
import { createBuilder, fullConversationView } from './handlers';
import { appendTerminateRunGraphMutations, planTerminateRunGraph } from './terminateRunGraph';
import { runGraphCascadeForPolicy } from './cancellationIntent';
import type {
  DurableConversationFacts,
  EnqueueTurnCommandPayload,
  InterruptTurnCommandPayload,
  PromoteTurnIntentCommandPayload,
  StartTurnCommandPayload,
  SteerTurnCommandPayload,
  TurnIntentControlCommandPayload
} from './types';

export interface StartTurnIds extends Record<string, string> {
  turnId: RunId;
  messageId: MessageId;
  revisionId: MessageRevisionId;
  authoritySnapshotId: AuthoritySnapshotId;
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

export interface EnqueueTurnIds extends Record<string, string> {
  intentId: TurnIntentId;
  revisionId: TurnIntentRevisionId;
  executionPresetRevisionId: RelationId;
}

export interface SteerTurnIds extends Record<string, string> {
  pendingInputId: PendingTurnInputId;
}

export interface UpdateTurnIntentIds extends Record<string, string> {
  revisionId: TurnIntentRevisionId;
}

export type StartTurnResult = {
  turnId: RunId;
  messageId: MessageId;
  leaseEpoch: number;
  disposition: 'started';
};

export type EnqueueTurnResult = {
  intentId: TurnIntentId;
  disposition: 'queued';
};

export type SteerTurnResult = {
  pendingInputId: PendingTurnInputId;
  targetTurnId: RunId;
  targetLeaseEpoch: number;
  disposition: 'pending_safe_boundary';
};

export class StartTurnCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, StartTurnResult, StartTurnIds> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullConversationView('turn.start', payloadOf<StartTurnCommandPayload>(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: CommandEnvelope<JsonValue>,
    context: CommandPlanningContext<StartTurnIds>
  ): TransitionPlan<StartTurnResult> | CommandRejection {
    const payload = payloadOf<StartTurnCommandPayload>(command);
    const invalid = validateConversation(view, payload.conversationId) ?? validateContent(payload.content);
    if (invalid) return invalid;
    if (!payload.agentId.trim()) return reject('invalid_state', 'Turn start requires a target Agent.');
    const activeLease = effectiveConversationExecutionLease(view.facts, payload.conversationId);
    if (activeLease) {
      return reject('invalid_state', `Conversation is already executing Turn ${activeLease.turnId} at lease epoch ${activeLease.epoch}.`);
    }

    if (!context.authoritySnapshot) throw new Error('Turn start has no complete server-compiled AuthoritySnapshot.');
    const builder = createBuilder(view, command, context.transitionId);
    const admitted = appendAdmittedTurn(builder, view.facts, {
      conversationId: payload.conversationId,
      agentId: payload.agentId,
      content: payload.content,
      now: context.now,
      ids: context.ids,
      authority: cloneJson(context.authoritySnapshot),
      source: { kind: 'direct', sourceId: command.commandId }
    });
    const lease = view.facts.executionLeases.find((candidate) => candidate.conversationId === payload.conversationId);
    const leaseEpoch = (lease?.epoch ?? 0) + 1;
    builder
      .upsert('conversation', {
        ...view.facts.conversation,
        lastActivityAt: Math.max(view.facts.conversation.createdAt, view.facts.conversation.lastActivityAt, context.now)
      })
      .patch(payload.conversationId, { kind: 'turn.started', turnId: admitted.turn.id, messageId: admitted.message.id, leaseEpoch });
    return builder.build(asJson({
      turnId: admitted.turn.id,
      messageId: admitted.message.id,
      leaseEpoch,
      disposition: 'started'
    }) as StartTurnResult);
  }
}

export class EnqueueTurnCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, EnqueueTurnResult, EnqueueTurnIds> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullConversationView('turn.enqueue', payloadOf<EnqueueTurnCommandPayload>(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: CommandEnvelope<JsonValue>,
    context: CommandPlanningContext<EnqueueTurnIds>
  ): TransitionPlan<EnqueueTurnResult> | CommandRejection {
    const payload = payloadOf<EnqueueTurnCommandPayload>(command);
    const invalid = validateConversation(view, payload.conversationId) ?? validateContent(payload.content);
    if (invalid) return invalid;
    if (!payload.agentId.trim()) return reject('invalid_state', 'Turn enqueue requires a target Agent.');
    const content = cloneContent(payload.content);
    if (!context.authoritySnapshot) throw new Error('Turn enqueue has no complete server-compiled AuthoritySnapshot.');
    const authority = cloneJson(context.authoritySnapshot);
    const revision = {
      id: context.ids.revisionId,
      turnIntentId: context.ids.intentId,
      content: content as unknown as JsonValue,
      contentHash: canonicalSha256(content),
      createdAt: context.now
    };
    const presetPayload = {
      agentId: payload.agentId,
      requestedAuthority: authority
    };
    const preset = {
      id: context.ids.executionPresetRevisionId,
      turnIntentId: context.ids.intentId,
      agentId: payload.agentId,
      requestedAuthority: authority,
      contentHash: canonicalSha256(presetPayload),
      createdAt: context.now
    };
    const intent = {
      id: context.ids.intentId,
      conversationId: payload.conversationId,
      currentRevisionId: revision.id,
      executionPresetRevisionId: preset.id,
      order: nextIntentOrder(view.facts),
      hold: 'none' as const,
      state: 'queued' as const,
      rowVersion: 1,
      createdAt: context.now,
      updatedAt: context.now
    };
    const builder = createBuilder(view, command, context.transitionId);
    builder
      .generatedId(intent.id, revision.id, preset.id)
      .upsert('turnIntents', intent)
      .upsert('turnIntentRevisions', revision)
      .upsert('turnExecutionPresetRevisions', preset)
      .upsert('conversation', {
        ...view.facts.conversation,
        lastActivityAt: Math.max(view.facts.conversation.createdAt, view.facts.conversation.lastActivityAt, context.now)
      })
      .patch(payload.conversationId, { kind: 'turnIntent.queued', intentId: intent.id });
    return builder.build(asJson({ intentId: intent.id, disposition: 'queued' }) as EnqueueTurnResult);
  }
}

export class SteerTurnCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, SteerTurnResult, SteerTurnIds> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullConversationView('turn.steer', payloadOf<SteerTurnCommandPayload>(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: CommandEnvelope<JsonValue>,
    context: CommandPlanningContext<SteerTurnIds>
  ): TransitionPlan<SteerTurnResult> | CommandRejection {
    const payload = payloadOf<SteerTurnCommandPayload>(command);
    const invalid = validateConversation(view, payload.conversationId) ?? validateContent(payload.content);
    if (invalid) return invalid;
    const lease = effectiveConversationExecutionLease(view.facts, payload.conversationId);
    if (!lease) return reject('invalid_state', 'Conversation has no active Turn to steer.');
    if (lease.turnId !== payload.targetTurnId || lease.epoch !== payload.targetLeaseEpoch) {
      return reject('stale_version', `Steer target changed to Turn ${lease.turnId} at lease epoch ${lease.epoch}.`);
    }
    const turn = view.facts.turns.find((candidate) => candidate.id === payload.targetTurnId);
    if (!turn || turn.lifecycle !== 'active' || turn.phase === 'terminal') return reject('invalid_state', 'Steer target is not active.');
    if (!isSteerablePhase(turn.phase) || lease.state !== 'active') {
      return reject('invalid_state', `Turn ${turn.id} phase ${turn.phase} is not steerable.`);
    }
    const content = cloneContent(payload.content);
    const pending = {
      id: context.ids.pendingInputId,
      conversationId: payload.conversationId,
      targetTurnId: turn.id,
      targetLeaseEpoch: lease.epoch,
      content: content as unknown as JsonValue,
      contentHash: canonicalSha256(content),
      fallback: payload.fallback,
      state: 'pending' as const,
      rowVersion: 1,
      createdAt: context.now,
      updatedAt: context.now
    };
    const builder = createBuilder(view, command, context.transitionId);
    builder
      .generatedId(pending.id)
      .upsert('pendingTurnInputs', pending)
      .patch(payload.conversationId, {
        kind: 'turnInput.pending',
        pendingInputId: pending.id,
        targetTurnId: turn.id,
        targetLeaseEpoch: lease.epoch
      });
    return builder.build(asJson({
      pendingInputId: pending.id,
      targetTurnId: turn.id,
      targetLeaseEpoch: lease.epoch,
      disposition: 'pending_safe_boundary'
    }) as SteerTurnResult);
  }
}

export class InterruptTurnCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, JsonValue, Record<string, string>> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = payloadOf<InterruptTurnCommandPayload>(command);
    return {
      ...fullConversationView('turn.interrupt', payload.conversationId),
      closedRunGraphRoots: [payload.turnId],
      closedRunGraphModes: payload.cascadeChildAgents ? ['foreground', 'background'] : ['foreground']
    };
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: CommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | CommandRejection {
    const payload = payloadOf<InterruptTurnCommandPayload>(command);
    const invalid = validateConversation(view, payload.conversationId);
    if (invalid) return invalid;
    const turn = view.facts.turns.find((candidate) => candidate.id === payload.turnId);
    const lease = effectiveConversationExecutionLease(view.facts, payload.conversationId);
    const builder = createBuilder(view, command, context.transitionId);

    if (!lease) {
      if (turn?.phase === 'terminal') {
        return builder.build(asJson({
          status: 'already_terminal',
          turnId: turn.id,
          terminalLifecycle: turn.lifecycle
        }));
      }
      return builder.build(asJson({ status: 'target_replaced', requestedTurnId: payload.turnId, activeTurnId: null }));
    }
    if (lease.turnId !== payload.turnId || lease.epoch !== payload.leaseEpoch) {
      return builder.build(asJson({
        status: 'target_replaced',
        requestedTurnId: payload.turnId,
        requestedLeaseEpoch: payload.leaseEpoch,
        activeTurnId: lease.turnId,
        activeLeaseEpoch: lease.epoch,
        activeLeaseState: lease.state
      }));
    }
    if (!turn || turn.lifecycle !== 'active' || turn.phase === 'terminal') {
      return builder.build(asJson({ status: 'already_terminal', turnId: payload.turnId }));
    }

    const termination = planTerminateRunGraph(view.facts, {
      rootRunIds: [turn.id],
      termination: { kind: 'interrupted', actor: 'user', reasonCode: 'user_cancelled' },
      ...runGraphCascadeForPolicy(payload.cascadeChildAgents ? 'full_tree_stop' : 'conversation_stop')
    });
    appendTerminateRunGraphMutations(builder, view.facts, termination, context.now);
    appendInterruptedPendingInputFallbacks(builder, view.facts, turn.id, context.now);
    builder.patch(payload.conversationId, {
      kind: 'turn.interrupted',
      turnId: turn.id,
      leaseEpoch: lease.epoch,
      affectedTurnIds: termination.affectedRunIds
    });
    return builder.build(asJson({
      status: 'interrupt_committed',
      turnId: turn.id,
      leaseEpoch: lease.epoch,
      affectedTurnIds: termination.affectedRunIds,
      cancelledAttemptIds: termination.invalidatedAttemptIds,
      detachedBackgroundTurnIds: termination.detachedBackgroundChildRunIds,
      backgroundPolicy: 'preserve_and_detach'
    }));
  }
}

export class PromoteTurnIntentCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, JsonValue, StartTurnIds> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = payloadOf<PromoteTurnIntentCommandPayload>(command);
    return {
      ...fullConversationView('turnIntent.promote', payload.conversationId),
      closedRunGraphRoots: payload.expectedActiveTurnId ? [payload.expectedActiveTurnId] : []
    };
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: CommandEnvelope<JsonValue>,
    context: CommandPlanningContext<StartTurnIds>
  ): TransitionPlan<JsonValue> | CommandRejection {
    const payload = payloadOf<PromoteTurnIntentCommandPayload>(command);
    const invalid = validateConversation(view, payload.conversationId);
    if (invalid) return invalid;
    const intent = view.facts.turnIntents.find((candidate) => candidate.id === payload.intentId);
    if (!intent || intent.conversationId !== payload.conversationId) return reject('not_found', `TurnIntent not found: ${payload.intentId}`);
    if (intent.rowVersion !== payload.intentRowVersion) return reject('stale_version', `TurnIntent changed: ${intent.id}`);
    if (intent.state !== 'queued') return reject('invalid_state', `TurnIntent ${intent.id} is already ${intent.state}.`);

    const lease = effectiveConversationExecutionLease(view.facts, payload.conversationId);
    if (lease) {
      if (!payload.replaceActive) return reject('invalid_state', `Conversation is executing Turn ${lease.turnId}.`);
      if (payload.expectedActiveTurnId !== lease.turnId || payload.expectedLeaseEpoch !== lease.epoch) {
        return reject('stale_version', `Execution target changed to Turn ${lease.turnId} at lease epoch ${lease.epoch}.`);
      }
    } else if (payload.expectedActiveTurnId || payload.expectedLeaseEpoch !== undefined) {
      return reject('stale_version', 'Conversation became idle before TurnIntent promotion.');
    }

    const revision = view.facts.turnIntentRevisions.find((candidate) => candidate.id === intent.currentRevisionId && candidate.turnIntentId === intent.id);
    const preset = view.facts.turnExecutionPresetRevisions.find((candidate) => candidate.id === intent.executionPresetRevisionId && candidate.turnIntentId === intent.id);
    if (!revision || canonicalSha256(revision.content) !== revision.contentHash || !preset || !preset.agentId.trim()) {
      throw new Error(`TurnIntent ${intent.id} has incomplete admission data.`);
    }
    const content = cloneContent(revision.content as unknown as MessageContent);
    const contentError = validateContent(content);
    if (contentError) return contentError;
    const builder = createBuilder(view, command, context.transitionId);
    if (lease) {
      const termination = planTerminateRunGraph(view.facts, {
        rootRunIds: [lease.turnId],
        termination: { kind: 'cancelled', actor: 'user', reasonCode: 'run_promoted' },
        ...runGraphCascadeForPolicy('run_replacement')
      });
      appendTerminateRunGraphMutations(builder, view.facts, termination, context.now);
    }
    const admitted = appendAdmittedTurn(builder, view.facts, {
      conversationId: payload.conversationId,
      agentId: preset.agentId,
      content,
      now: context.now,
      ids: context.ids,
      authority: cloneJson(preset.requestedAuthority),
      source: { kind: 'turn_intent', sourceId: intent.id },
      ...(lease ? { replaceLeaseOwner: lease.turnId } : {})
    });
    builder
      .upsert('turnIntents', {
        ...intent,
        state: 'admitted',
        admittedTurnId: admitted.turn.id,
        admittedAt: context.now,
        rowVersion: intent.rowVersion + 1,
        updatedAt: context.now
      })
      .patch(payload.conversationId, {
        kind: 'turnIntent.promoted',
        intentId: intent.id,
        turnId: admitted.turn.id,
        replacedTurnId: lease?.turnId
      });
    return builder.build(asJson({
      status: 'admitted',
      intentId: intent.id,
      turnId: admitted.turn.id,
      ...(lease ? { replacedTurnId: lease.turnId } : {})
    }));
  }
}

export class TurnIntentControlCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, JsonValue, UpdateTurnIntentIds> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullConversationView('turnIntent.control', payloadOf<TurnIntentControlCommandPayload>(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: CommandEnvelope<JsonValue>,
    context: CommandPlanningContext<UpdateTurnIntentIds>
  ): TransitionPlan<JsonValue> | CommandRejection {
    const payload = payloadOf<TurnIntentControlCommandPayload>(command);
    const invalid = validateConversation(view, payload.conversationId);
    if (invalid) return invalid;
    const builder = createBuilder(view, command, context.transitionId);

    if (payload.action === 'resume_all') {
      const held = view.facts.turnIntents.filter((intent) => intent.conversationId === payload.conversationId
        && intent.state === 'queued' && intent.hold !== 'none');
      for (const intent of held) builder.upsert('turnIntents', { ...intent, hold: 'none', rowVersion: intent.rowVersion + 1, updatedAt: context.now });
      builder.patch(payload.conversationId, { kind: 'turnIntent.resumeAll', intentIds: held.map((intent) => intent.id) });
      return builder.build(asJson({ status: 'updated', action: payload.action, affectedIntentIds: held.map((intent) => intent.id) }));
    }

    if (payload.action === 'reorder') {
      const requested = payload.orderedIntents ?? [];
      const queued = view.facts.turnIntents
        .filter((intent) => intent.conversationId === payload.conversationId && intent.state === 'queued')
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
      if (requested.length !== queued.length || new Set(requested.map((item) => item.intentId)).size !== requested.length) {
        return reject('invalid_state', 'TurnIntent reorder must name every queued intent exactly once.');
      }
      const byId = new Map(queued.map((intent) => [intent.id, intent]));
      for (const [index, requestedIntent] of requested.entries()) {
        const intent = byId.get(requestedIntent.intentId);
        if (!intent || intent.rowVersion !== requestedIntent.rowVersion) return reject('stale_version', `TurnIntent changed: ${requestedIntent.intentId}`);
        builder.upsert('turnIntents', { ...intent, order: (index + 1) * 1_000, rowVersion: intent.rowVersion + 1, updatedAt: context.now });
      }
      builder.patch(payload.conversationId, { kind: 'turnIntent.reordered', intentIds: requested.map((item) => item.intentId) });
      return builder.build(asJson({ status: 'updated', action: payload.action, affectedIntentIds: requested.map((item) => item.intentId) }));
    }

    if (!payload.intentId || payload.intentRowVersion === undefined) return reject('invalid_state', 'TurnIntent control requires intentId and rowVersion.');
    const intent = view.facts.turnIntents.find((candidate) => candidate.id === payload.intentId);
    if (!intent || intent.conversationId !== payload.conversationId) return reject('not_found', `TurnIntent not found: ${payload.intentId}`);
    if (intent.rowVersion !== payload.intentRowVersion) return reject('stale_version', `TurnIntent changed: ${intent.id}`);
    if (intent.state !== 'queued') return reject('invalid_state', `TurnIntent ${intent.id} is already ${intent.state}.`);

    if (payload.action === 'update') {
      const contentError = validateContent(payload.content);
      if (contentError) return contentError;
      const content = cloneContent(payload.content!);
      const revision = {
        id: context.ids.revisionId,
        turnIntentId: intent.id,
        content: content as unknown as JsonValue,
        contentHash: canonicalSha256(content),
        createdAt: context.now
      };
      builder
        .generatedId(revision.id)
        .upsert('turnIntentRevisions', revision)
        .upsert('turnIntents', { ...intent, currentRevisionId: revision.id, rowVersion: intent.rowVersion + 1, updatedAt: context.now });
    } else if (payload.action === 'cancel') {
      builder.upsert('turnIntents', { ...intent, state: 'cancelled', cancelledAt: context.now, rowVersion: intent.rowVersion + 1, updatedAt: context.now });
    } else if (payload.action === 'pause') {
      builder.upsert('turnIntents', { ...intent, hold: 'manual', rowVersion: intent.rowVersion + 1, updatedAt: context.now });
    } else if (payload.action === 'resume') {
      builder.upsert('turnIntents', { ...intent, hold: 'none', rowVersion: intent.rowVersion + 1, updatedAt: context.now });
    } else {
      return reject('invalid_state', `Unsupported TurnIntent action: ${payload.action}`);
    }
    builder.patch(payload.conversationId, { kind: `turnIntent.${payload.action}`, intentId: intent.id });
    return builder.build(asJson({ status: 'updated', action: payload.action, affectedIntentIds: [intent.id] }));
  }
}

function appendInterruptedPendingInputFallbacks(
  builder: ReturnType<typeof createBuilder>,
  facts: DurableConversationFacts,
  turnId: RunId,
  now: number
): void {
  const target = facts.runTargets.find((candidate) => candidate.runId === turnId && candidate.role === 'executor');
  const authority = facts.authoritySnapshots.find((candidate) => candidate.turnId === turnId);
  let order = nextIntentOrder(facts);
  for (const input of facts.pendingTurnInputs
    .filter((candidate) => candidate.targetTurnId === turnId && candidate.state === 'pending')
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
    if (input.fallback === 'queue_next' && target && authority) {
      const intentId = stableIdFromSeed('turnIntent', `interrupted-pending-input:${input.id}:intent`);
      const revisionId = stableIdFromSeed('turnIntentRevision', `interrupted-pending-input:${input.id}:revision`);
      const presetId = stableIdFromSeed('relation', `interrupted-pending-input:${input.id}:preset`);
      builder
        .generatedId(intentId, revisionId, presetId)
        .upsert('turnIntentRevisions', {
          id: revisionId,
          turnIntentId: intentId,
          content: cloneJson(input.content),
          contentHash: input.contentHash,
          createdAt: now
        })
        .upsert('turnExecutionPresetRevisions', {
          id: presetId,
          turnIntentId: intentId,
          agentId: target.agentId,
          requestedAuthority: cloneJson(authority.authority),
          contentHash: canonicalSha256({ agentId: target.agentId, requestedAuthority: authority.authority }),
          createdAt: now
        })
        .upsert('turnIntents', {
          id: intentId,
          conversationId: input.conversationId,
          currentRevisionId: revisionId,
          executionPresetRevisionId: presetId,
          order,
          hold: 'none',
          state: 'queued',
          rowVersion: 1,
          createdAt: now,
          updatedAt: now
        });
      order += 1_000;
    }
    builder.upsert('pendingTurnInputs', {
      ...input,
      state: input.fallback === 'reject' ? 'rejected' : 'cancelled',
      rowVersion: input.rowVersion + 1,
      updatedAt: now
    });
  }
}

function payloadOf<T>(command: CommandEnvelope<JsonValue>): T {
  return command.payload as unknown as T;
}

function validateConversation(
  view: DurableAggregateView<DurableConversationFacts>,
  conversationId: string
): CommandRejection | undefined {
  if (view.facts.conversation.id !== conversationId || !view.scopes.includes(conversationId as DurableConversationFacts['conversation']['id'])) {
    return reject('not_found', `Conversation not found: ${conversationId}`);
  }
  if (view.facts.conversation.visibility === 'hidden') return reject('invalid_state', 'Conversation has been deleted.');
  return undefined;
}

function validateContent(content: MessageContent | undefined): CommandRejection | undefined {
  if (!content || content.role !== 'user' || !Array.isArray(content.parts) || content.parts.length === 0) {
    return reject('invalid_state', 'User input content cannot be empty.');
  }
  return undefined;
}

function isSteerablePhase(phase: DurableConversationFacts['turns'][number]['phase']): boolean {
  return phase !== 'terminal'
    && phase !== 'paused'
    && phase !== 'waiting_user'
    && phase !== 'waiting_plan_review';
}

function nextIntentOrder(facts: DurableConversationFacts): number {
  return facts.turnIntents
    .filter((intent) => intent.state === 'queued')
    .reduce((max, intent) => Math.max(max, intent.order), 0) + 1_000;
}

function cloneContent(content: MessageContent): MessageContent {
  return JSON.parse(JSON.stringify(content)) as MessageContent;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function reject(code: CommandRejection['code'], message: string): CommandRejection {
  return { status: 'rejected', code, message };
}
