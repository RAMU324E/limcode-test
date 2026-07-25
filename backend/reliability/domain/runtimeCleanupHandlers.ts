import type {
  CommandPlanningContext,
  DurableAggregateView,
  DurableViewSpec,
  InternalCommandEnvelope,
  InternalCommandHandler,
  InternalCommandNoop,
  JsonValue,
  TransitionPlan
} from '../../../shared/conversationReliability';
import type { AttemptId, ConversationId, OperationId } from '../../../shared/stableIds';
import { completeAttempt, matchCurrentAttempt } from './operationStateMachine';
import { builderFor, fullView } from './internalHandlers';
import { asJson } from './transitionBuilder';
import type { DurableConversationFacts } from './types';

export interface CompleteRuntimeCleanupPayload {
  conversationId: ConversationId;
  operationId: OperationId;
  attemptId: AttemptId;
  generation: number;
  cleanedTargetCount: number;
}

export class CompleteRuntimeCleanupHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('runtime.cleanup.completed', payload(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const input = payload(command);
    const matched = matchCurrentAttempt(view.facts, input);
    if (matched.status === 'stale') {
      return { status: 'stale', result: asJson({ status: 'stale', reason: matched.reason }) };
    }
    if (matched.attempt.state !== 'dispatched'
      || matched.operation.ownerKind !== 'conversation'
      || matched.operation.kind !== 'runtime.cleanup'
      || matched.effect?.kind !== 'runtime.cleanup') {
      return { status: 'stale', result: asJson({ status: 'stale', reason: 'runtime_cleanup_attempt_mismatch' }) };
    }
    const builder = builderFor(view, context, input.conversationId);
    for (const mutation of completeAttempt(view.facts, {
      operationId: input.operationId,
      attemptId: input.attemptId,
      generation: input.generation,
      now: context.now,
      outcome: 'succeeded'
    }).mutations) {
      if (mutation.kind === 'upsert') builder.upsert(mutation.family as never, mutation.record as never);
      else if (mutation.kind === 'remove') builder.remove(mutation.family as never, mutation.id);
      else builder.removeMany(mutation.family as never, mutation.ids);
    }
    builder.patch(input.conversationId, {
      kind: 'runtime.cleanup_completed',
      operationId: input.operationId,
      cleanedTargetCount: input.cleanedTargetCount
    });
    return builder.build(asJson({ status: 'cleaned', cleanedTargetCount: input.cleanedTargetCount }));
  }
}

function payload(command: InternalCommandEnvelope<JsonValue>): CompleteRuntimeCleanupPayload {
  return command.payload as unknown as CompleteRuntimeCleanupPayload;
}
