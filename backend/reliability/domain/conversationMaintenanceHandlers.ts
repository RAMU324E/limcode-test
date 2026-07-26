import type {
  AttemptRecord,
  CommandPlanningContext,
  DurableAggregateView,
  DurableEffectPayloadRecord,
  DurableViewSpec,
  InternalCommandEnvelope,
  InternalCommandHandler,
  InternalCommandNoop,
  JsonValue,
  OperationRecord,
  PrimaryEffectDescriptor,
  RecordMutation,
  TransitionPlan
} from '../../../shared/conversationReliability';
import type {
  CheckpointDismissPayload,
  CompressionDeletePayload,
  CompressionTogglePayload,
  CompressionUpdatePayload,
  MessageContent
} from '../../../shared/protocol';
import type {
  AttemptId,
  ConversationId,
  EffectIntentId,
  InvocationId,
  MessageId,
  OperationId
} from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { applyCompressionResultAddenda } from '../../modelContext/compressionResult';
import { builderFor, fullView, policyNumber as frozenRunPolicyNumber } from './internalHandlers';
import {
  appendCompressionModelContextProjection,
  appendRemoveCompressionModelContextGraph,
  collectCompressionBlockDependencyClosure
} from './modelContextProjection';
import { compressionProjectionIdentity, validateCompressionContextProjection } from './compressionValidity';
import { planReliableManualCompression, type ReliableManualCompressionInput } from './manualCompressionPlanner';
import { completeAttempt, matchCurrentAttempt } from './operationStateMachine';
import type { ReliableBarrierEffectPayload, ReliableCompressionBarrierPlan, ReliableCompressionResult } from './preflightTypes';
import type { DurableConversationFacts } from './types';
import {
  planReliablePostResponseAutoCompression,
  reliableAutoCompressionAnchorSeed,
  reliableAutoCompressionIdentity
} from '../reliableAutoCompressionPlanner';

export interface ReliableCompressionUpdatePayload extends CompressionUpdatePayload {
  variantId: string;
}

export interface StartManualCompressionPayload {
  conversationId: ConversationId;
  request: ReliableManualCompressionInput;
  seed: string;
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

export interface CompleteStandaloneCompressionPayload extends ReliableCompressionResult {
  conversationId: ConversationId;
  operationId: OperationId;
  attemptId: AttemptId;
  generation: number;
  plan: ReliableCompressionBarrierPlan;
}

export type CompleteManualCompressionPayload = CompleteStandaloneCompressionPayload;

export interface StartAutoCompressionPayload {
  conversationId: ConversationId;
  invocationId: InvocationId;
  modelMessageId: MessageId;
  seed: string;
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

export class StartManualCompressionHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('compression.manual.start', payloadOf<StartManualCompressionPayload>(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<StartManualCompressionPayload>(command);
    if (payload.seed !== command.sourceKey) return stale('compression_seed_source_mismatch');
    let plan: ReliableCompressionBarrierPlan;
    try {
      plan = planReliableManualCompression(view.facts, payload.request, payload.seed, context.now);
    } catch (error) {
      return stale(`compression_plan_invalid:${error instanceof Error ? error.message : String(error)}`);
    }
    if (view.facts.compressionBlocks.some((candidate) => candidate.id === plan.block.id)) return stale('compression_id_reused');
    const replacement = payload.request.replaceBlockId
      ? unique(view.facts.compressionBlocks, payload.request.replaceBlockId, 'Replaced CompressionBlock')
      : undefined;

    const { durablePlan, operation, attempt, effectPayload, effect } = standaloneCompressionProgress({
      conversationId: payload.conversationId,
      trigger: 'manual',
      ids: payload,
      plan,
      now: context.now,
      deadlineMs: policyNumber(context.policySnapshot, 'compressionDeadlineMs')
    });

    const builder = builderFor(view, context, payload.conversationId);
    if (replacement) {
      const dependents = collectCompressionBlockDependencyClosure(view.facts, new Set([replacement.id]));
      for (const dependent of view.facts.compressionBlocks.filter((candidate) => candidate.id !== replacement.id && dependents.has(candidate.id) && candidate.status === 'complete')) {
        builder.upsert('compressionBlocks', {
          ...dependent,
          status: 'stale',
          staleReason: 'source_compression_regenerated',
          updatedAt: context.now
        });
      }
      builder.upsert('compressionBlocks', {
        ...replacement,
        status: 'stale',
        staleReason: '已重新生成新的压缩块。',
        updatedAt: context.now
      });
    }
    builder
      .generatedId(durablePlan.block.id, durablePlan.variantId, durablePlan.compactRequest.id, ...(durablePlan.compactRequest.invocationId ? [durablePlan.compactRequest.invocationId] : []), operation.id, attempt.id, effect.effectIntentId)
      .upsert('compressionBlocks', durablePlan.block);
    for (const link of durablePlan.sourceLinks) {
      builder.generatedId(link.id).upsert('compressionBlockSourceLinks', link);
    }
    appendCompressionModelContextProjection(builder, durablePlan.contextProjection, context.now);
    builder
      .upsert('operations', operation)
      .upsert('attempts', attempt)
      .upsert('primaryEffects', { id: effect.effectIntentId, ...effect })
      .upsert('effectPayloads', effectPayload)
      .primaryEffect(effect)
      .patch(payload.conversationId, { kind: 'compression.manual.started', blockId: plan.block.id, operationId: operation.id });
    return builder.build(asJson({ status: 'started', blockId: plan.block.id, operationId: operation.id }));
  }
}

export class StartAutoCompressionHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('compression.auto.start', payloadOf<StartAutoCompressionPayload>(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<StartAutoCompressionPayload>(command);
    const expectedSeed = reliableAutoCompressionAnchorSeed(payload.conversationId, payload.invocationId, payload.modelMessageId);
    if (payload.seed !== expectedSeed) return stale('compression_seed_anchor_mismatch');
    const expectedIds = reliableAutoCompressionIdentity(payload.seed);
    if (payload.operationId !== expectedIds.operationId
      || payload.attemptId !== expectedIds.attemptId
      || payload.effectIntentId !== expectedIds.effectIntentId) {
      return stale('compression_identity_seed_mismatch');
    }

    const decision = planReliablePostResponseAutoCompression(view.facts, context.now);
    if (decision.kind !== 'ready') {
      return satisfied(`auto_compression_${decision.kind}:${decision.reason}`);
    }
    if (decision.anchor.invocationId !== payload.invocationId
      || decision.anchor.modelMessageId !== payload.modelMessageId
      || decision.anchor.seed !== payload.seed) {
      return stale('auto_compression_anchor_changed');
    }
    if (view.facts.compressionBlocks.some((candidate) => candidate.id === decision.plan.block.id)
      || view.facts.operations.some((candidate) => candidate.id === payload.operationId)) {
      return satisfied('auto_compression_anchor_already_processed');
    }

    const { durablePlan, operation, attempt, effectPayload, effect } = standaloneCompressionProgress({
      conversationId: payload.conversationId,
      trigger: 'auto',
      ids: payload,
      plan: decision.plan,
      now: context.now,
      deadlineMs: frozenRunPolicyNumber(view.facts, decision.anchor.runId, 'compressionDeadlineMs')
    });
    const builder = builderFor(view, context, payload.conversationId);
    builder
      .generatedId(durablePlan.block.id, durablePlan.variantId, durablePlan.compactRequest.id, ...(durablePlan.compactRequest.invocationId ? [durablePlan.compactRequest.invocationId] : []), operation.id, attempt.id, effect.effectIntentId)
      .upsert('compressionBlocks', durablePlan.block);
    for (const link of durablePlan.sourceLinks) builder.generatedId(link.id).upsert('compressionBlockSourceLinks', link);
    appendCompressionModelContextProjection(builder, durablePlan.contextProjection, context.now);
    builder
      .upsert('operations', operation)
      .upsert('attempts', attempt)
      .upsert('primaryEffects', { id: effect.effectIntentId, ...effect })
      .upsert('effectPayloads', effectPayload)
      .primaryEffect(effect)
      .patch(payload.conversationId, {
        kind: 'compression.auto.started',
        blockId: durablePlan.block.id,
        operationId: operation.id,
        invocationId: decision.anchor.invocationId,
        modelMessageId: decision.anchor.modelMessageId,
        observedTokenCount: decision.observedTokenCount,
        thresholdTokenCount: decision.thresholdTokenCount
      });
    return builder.build(asJson({
      status: 'started',
      trigger: 'auto',
      blockId: durablePlan.block.id,
      operationId: operation.id,
      invocationId: decision.anchor.invocationId,
      modelMessageId: decision.anchor.modelMessageId,
      observedTokenCount: decision.observedTokenCount,
      thresholdTokenCount: decision.thresholdTokenCount
    }));
  }
}

export class CompleteStandaloneCompressionHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('compression.standalone.complete', payloadOf<CompleteStandaloneCompressionPayload>(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<CompleteStandaloneCompressionPayload>(command);
    const matched = matchCurrentAttempt(view.facts, payload);
    if (matched.status === 'stale') return stale(matched.reason);
    const trigger = payload.plan.block.trigger;
    if ((trigger !== 'manual' && trigger !== 'auto')
      || matched.attempt.state !== 'dispatched'
      || matched.operation.kind !== `compression.${trigger}`) {
      return stale('standalone_compression_attempt_not_dispatched');
    }
    const block = unique(view.facts.compressionBlocks, payload.plan.block.id, 'CompressionBlock');
    const projectionIdentity = block ? compressionProjectionIdentity(view.facts, block.id) : undefined;
    if (!block || block.status !== 'running'
      || payload.plan.compactRequest.blockId !== block.id
      || payload.plan.compactRequest.sourceHash !== block.sourceHash
      || !projectionIdentity
      || payload.plan.contextProjection.compressionLink.blockId !== block.id
      || payload.plan.contextProjection.compressionLink.projectionId !== projectionIdentity.projection.id
      || payload.plan.contextProjection.projection.id !== projectionIdentity.projection.id
      || payload.plan.contextProjection.projection.fingerprint !== projectionIdentity.projection.fingerprint
      || canonicalSha256(payload.plan.compactRequest.contents as unknown as JsonValue)
        !== canonicalSha256(projectionIdentity.projection.contents as unknown as JsonValue)) {
      return stale('standalone_compression_identity_mismatch');
    }
    if (payload.outcome === 'succeeded' && !payload.result) return stale('compression_result_missing');

    const sourceValidity = payload.outcome === 'succeeded'
      ? validateCompressionContextProjection(view.facts, block.id)
      : { valid: true as const };
    const effectiveOutcome = sourceValidity.valid ? payload.outcome : 'failed';
    const effectiveError = sourceValidity.valid
      ? payload.error
      : `compression_source_invalid:${sourceValidity.reason ?? 'unknown'}`;
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, completeAttempt(view.facts, {
      operationId: payload.operationId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      now: context.now,
      outcome: effectiveOutcome,
      error: effectiveError
    }).mutations);
    if (payload.outcome === 'succeeded' && sourceValidity.valid) {
      const result = payload.result!;
      const contents = applyCompressionResultAddenda(result.contents, projectionIdentity.projection.resultAddenda);
      const methodKind = result.methodConfig?.kind ?? block.methodKind;
      builder
        .upsert('compressionBlocks', {
          ...block,
          status: 'complete',
          methodKind,
          ...(result.methodConfig?.id ? { methodConfigId: result.methodConfig.id } : {}),
          summaryPreview: compressionPreview(result.contents),
          ...(result.settingsSnapshot ? { providerSettingsSnapshot: clone(result.settingsSnapshot) } : {}),
          ...(result.methodConfig ? { compressionConfigSnapshot: clone(result.methodConfig) } : {}),
          updatedAt: payload.completedAt,
          completedAt: payload.completedAt
        })
        .upsert('compressionContextVariants', {
          id: payload.plan.variantId,
          blockId: block.id,
          kind: methodKind === 'openai_responses_compact' ? 'provider_native' : 'provider_neutral_summary',
          contents,
          ...(methodKind === 'openai_responses_compact' ? { compatibility: { provider: 'openai-responses', format: 'openai-responses', endpoint: 'responses.compact' } } : {}),
          ...(result.usageMetadata ? { usageMetadata: clone(result.usageMetadata) } : {}),
          ...(result.rawResponse !== undefined ? { rawResponse: clone(result.rawResponse) } : {}),
          createdAt: payload.completedAt,
          updatedAt: payload.completedAt
        });
    } else if (!sourceValidity.valid) {
      builder.upsert('compressionBlocks', {
        ...block,
        status: 'stale',
        staleReason: effectiveError,
        updatedAt: payload.completedAt,
        completedAt: payload.completedAt
      });
    } else {
      builder.upsert('compressionBlocks', {
        ...block,
        status: 'error',
        error: payload.error ?? 'compression_failed',
        updatedAt: payload.completedAt,
        completedAt: payload.completedAt
      });
    }
    builder.patch(payload.conversationId, { kind: `compression.${trigger}.completed`, blockId: block.id, outcome: effectiveOutcome });
    return builder.build(asJson({ status: effectiveOutcome, trigger, blockId: block.id }));
  }
}

export class DismissCheckpointHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('checkpoint.dismiss', payloadOf<CheckpointDismissPayload>(command).conversationId as ConversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<CheckpointDismissPayload>(command);
    const checkpoint = unique(view.facts.checkpoints, payload.checkpointId, 'Checkpoint');
    if (!checkpoint) return satisfied('checkpoint_missing');
    if (checkpoint.conversationId !== payload.conversationId) return stale('checkpoint_conversation_mismatch');
    if (checkpoint.status === 'pending') return stale('checkpoint_is_active');

    const builder = builderFor(view, context, payload.conversationId as ConversationId);
    for (const anchor of view.facts.checkpointTimelineAnchors.filter((candidate) => candidate.checkpointId === checkpoint.id)) {
      builder.remove('checkpointTimelineAnchors', anchor.id);
    }
    builder
      .remove('checkpoints', checkpoint.id)
      .patch(payload.conversationId as ConversationId, { kind: 'checkpoint.dismissed', checkpointId: checkpoint.id });
    return builder.build(asJson({ status: 'dismissed', checkpointId: checkpoint.id }));
  }
}

export class DeleteCompressionHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('compression.delete', payloadOf<CompressionDeletePayload>(command).conversationId as ConversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<CompressionDeletePayload>(command);
    const block = unique(view.facts.compressionBlocks, payload.blockId, 'CompressionBlock');
    if (!block) return satisfied('compression_missing');
    if (block.conversationId !== payload.conversationId) return stale('compression_conversation_mismatch');
    if (block.status === 'pending' || block.status === 'running') return stale('compression_is_active');

    const builder = builderFor(view, context, payload.conversationId as ConversationId);
    const blockIds = collectCompressionBlockDependencyClosure(view.facts, new Set([block.id]));
    appendRemoveCompressionModelContextGraph(builder, view.facts, blockIds);
    builder.removeMany('compressionBlockSourceLinks', view.facts.compressionBlockSourceLinks
      .filter((link) => blockIds.has(link.blockId))
      .map((link) => link.id));
    builder.removeMany('compressionContextVariants', view.facts.compressionContextVariants
      .filter((variant) => blockIds.has(variant.blockId))
      .map((variant) => variant.id));
    builder.removeMany('compressionBlockLlmInvocationLinks', view.facts.compressionBlockLlmInvocationLinks
      .filter((link) => blockIds.has(link.blockId))
      .map((link) => link.id));
    builder.removeMany('runCompressionBlockLinks', view.facts.runCompressionBlockLinks
      .filter((link) => blockIds.has(link.blockId))
      .map((link) => link.id));
    builder
      .removeMany('compressionBlocks', blockIds)
      .patch(payload.conversationId as ConversationId, { kind: 'compression.deleted', blockId: block.id });
    return builder.build(asJson({ status: 'deleted', blockId: block.id }));
  }
}

export class UpdateCompressionHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('compression.update', payloadOf<ReliableCompressionUpdatePayload>(command).conversationId as ConversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<ReliableCompressionUpdatePayload>(command);
    const block = unique(view.facts.compressionBlocks, payload.blockId, 'CompressionBlock');
    if (!block) return stale('compression_missing');
    if (block.conversationId !== payload.conversationId) return stale('compression_conversation_mismatch');

    const builder = builderFor(view, context, payload.conversationId as ConversationId);
    builder.upsert('compressionBlocks', {
      ...block,
      ...(payload.title !== undefined ? { title: payload.title.trim() || block.title } : {}),
      ...(payload.summaryPreview !== undefined ? { summaryPreview: payload.summaryPreview } : {}),
      updatedAt: context.now
    });

    if (payload.summaryContents?.length) {
      const variants = view.facts.compressionContextVariants.filter((candidate) =>
        candidate.blockId === block.id && candidate.kind === 'provider_neutral_summary');
      if (variants.length > 1) throw new Error(`CompressionBlock ${block.id} has multiple provider-neutral variants.`);
      const existing = variants[0];
      if (existing) {
        const affectedProjectionIds = new Set(view.facts.modelContextProjectionSourceLinks
          .filter((source) => source.sourceKind === 'compressionVariant' && source.sourceId === existing.id)
          .map((source) => source.projectionId));
        const seeds = new Set(view.facts.compressionModelContextProjectionLinks
          .filter((link) => affectedProjectionIds.has(link.projectionId))
          .map((link) => link.blockId));
        const staleBlocks = collectCompressionBlockDependencyClosure(view.facts, seeds);
        for (const dependent of view.facts.compressionBlocks.filter((candidate) => staleBlocks.has(candidate.id) && candidate.status === 'complete')) {
          builder.upsert('compressionBlocks', {
            ...dependent,
            status: 'stale',
            staleReason: 'source_compression_variant_updated',
            updatedAt: context.now
          });
        }
        builder.upsert('compressionContextVariants', {
          ...existing,
          contents: clone(payload.summaryContents),
          updatedAt: context.now
        });
      } else {
        builder
          .generatedId(payload.variantId)
          .upsert('compressionContextVariants', {
            id: payload.variantId,
            blockId: block.id,
            kind: 'provider_neutral_summary',
            contents: clone(payload.summaryContents),
            createdAt: context.now,
            updatedAt: context.now
          });
      }
    }
    builder.patch(payload.conversationId as ConversationId, { kind: 'compression.updated', blockId: block.id });
    return builder.build(asJson({ status: 'updated', blockId: block.id }));
  }
}

export class ToggleCompressionHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('compression.toggle', payloadOf<CompressionTogglePayload & { enabled: boolean }>(command).conversationId as ConversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<CompressionTogglePayload & { enabled: boolean }>(command);
    const block = unique(view.facts.compressionBlocks, payload.blockId, 'CompressionBlock');
    if (!block) return stale('compression_missing');
    if (block.conversationId !== payload.conversationId) return stale('compression_conversation_mismatch');
    if (block.status === 'pending' || block.status === 'running') return stale('compression_is_active');
    const status = payload.enabled ? 'complete' as const : 'disabled' as const;
    if (block.status === status) return satisfied('compression_already_toggled');
    if (payload.enabled) {
      const candidateFacts = {
        ...view.facts,
        compressionBlocks: view.facts.compressionBlocks.map((candidate) => candidate.id === block.id
          ? { ...candidate, status: 'complete' as const, staleReason: undefined }
          : candidate)
      };
      const validity = validateCompressionContextProjection(candidateFacts, block.id);
      if (!validity.valid) return stale(`compression_source_invalid:${validity.reason ?? 'unknown'}`);
    }

    const builder = builderFor(view, context, payload.conversationId as ConversationId);
    if (!payload.enabled) {
      const dependents = collectCompressionBlockDependencyClosure(view.facts, new Set([block.id]));
      for (const dependent of view.facts.compressionBlocks.filter((candidate) => candidate.id !== block.id && dependents.has(candidate.id) && candidate.status === 'complete')) {
        builder.upsert('compressionBlocks', {
          ...dependent,
          status: 'stale',
          staleReason: 'source_compression_disabled',
          updatedAt: context.now
        });
      }
    }
    builder
      .upsert('compressionBlocks', { ...block, status, ...(payload.enabled ? { staleReason: undefined } : {}), updatedAt: context.now })
      .patch(payload.conversationId as ConversationId, { kind: 'compression.toggled', blockId: block.id, enabled: payload.enabled });
    return builder.build(asJson({ status: payload.enabled ? 'enabled' : 'disabled', blockId: block.id }));
  }
}

function standaloneCompressionProgress(input: {
  conversationId: ConversationId;
  trigger: 'manual' | 'auto';
  ids: { operationId: OperationId; attemptId: AttemptId; effectIntentId: EffectIntentId };
  plan: ReliableCompressionBarrierPlan;
  now: number;
  deadlineMs: number;
}): {
  durablePlan: ReliableCompressionBarrierPlan;
  operation: OperationRecord;
  attempt: AttemptRecord;
  effectPayload: DurableEffectPayloadRecord;
  effect: PrimaryEffectDescriptor;
} {
  const deadlineAt = input.now + input.deadlineMs;
  const operation: OperationRecord = {
    ownerKind: 'conversation',
    id: input.ids.operationId,
    conversationId: input.conversationId,
    kind: `compression.${input.trigger}`,
    state: 'running',
    currentGeneration: 1,
    rowVersion: 1,
    timeoutPolicy: 'release_optional_barrier',
    createdAt: input.now,
    updatedAt: input.now
  };
  const attempt: AttemptRecord = {
    ownerKind: 'conversation',
    id: input.ids.attemptId,
    operationId: operation.id,
    conversationId: input.conversationId,
    generation: 1,
    state: 'pending',
    deadlineAt,
    rowVersion: 1
  };
  const durablePlan: ReliableCompressionBarrierPlan = {
    ...clone(input.plan),
    block: {
      ...clone(input.plan.block),
      trigger: input.trigger,
      ...(input.trigger === 'auto' ? { title: '自动上下文压缩' } : {}),
      createdAt: input.now,
      updatedAt: input.now
    },
    sourceLinks: input.plan.sourceLinks.map((link) => ({ ...clone(link), createdAt: input.now, updatedAt: input.now }))
  };
  const effectPayloadValue: ReliableBarrierEffectPayload = {
    barrier: 'compression.standalone',
    trigger: input.trigger,
    plan: durablePlan
  };
  const effectPayloadHash = canonicalSha256(effectPayloadValue as unknown as JsonValue);
  const effectPayload: DurableEffectPayloadRecord = {
    ownerKind: 'conversation',
    id: `effect-payload:${operation.id}:1`,
    conversationId: input.conversationId,
    operationId: operation.id,
    kind: operation.kind,
    payload: clone(effectPayloadValue) as unknown as JsonValue,
    payloadHash: effectPayloadHash,
    createdAt: input.now
  };
  const effect: PrimaryEffectDescriptor = {
    ownerKind: 'conversation',
    effectIntentId: input.ids.effectIntentId,
    conversationId: input.conversationId,
    operationId: operation.id,
    attemptId: attempt.id,
    generation: 1,
    kind: operation.kind,
    idempotencyKey: `${operation.id}:1`,
    recoveryPolicy: 'interrupt_on_restart',
    deadlineAt,
    payloadRef: { kind: 'record', id: effectPayload.id, hash: effectPayload.payloadHash }
  };
  return { durablePlan, operation, attempt, effectPayload, effect };
}

function appendMutations(
  builder: ReturnType<typeof builderFor>,
  mutations: readonly RecordMutation[]
): void {
  for (const mutation of mutations) {
    if (mutation.kind === 'upsert') builder.upsert(mutation.family as never, mutation.record as unknown as { id: string });
    else if (mutation.kind === 'remove') builder.remove(mutation.family as never, mutation.id);
    else builder.removeMany(mutation.family as never, mutation.ids);
  }
}

function policyNumber(policy: JsonValue, key: string): number {
  const value = policy && !Array.isArray(policy) && typeof policy === 'object' ? policy[key] : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`Planning policy has no valid ${key}.`);
  return value;
}

function compressionPreview(contents: readonly MessageContent[]): string | undefined {
  const text = contents
    .flatMap((content) => content.parts)
    .flatMap((part) => 'text' in part && typeof part.text === 'string' && part.thought !== true ? [part.text.trim()] : [])
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? (text.length > 240 ? `${text.slice(0, 239)}…` : text) : undefined;
}

function payloadOf<T>(command: InternalCommandEnvelope<JsonValue>): T {
  return command.payload as unknown as T;
}

function unique<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  const matches = records.filter((record) => record.id === id);
  if (matches.length > 1) throw new Error(`${label} Stable ID conflict: ${id}`);
  return matches[0];
}

function stale(reason: string): InternalCommandNoop<JsonValue> {
  return { status: 'stale', result: asJson({ status: 'stale', reason }) };
}

function satisfied(reason: string): InternalCommandNoop<JsonValue> {
  return { status: 'already_satisfied', result: asJson({ status: 'already_satisfied', reason }) };
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
