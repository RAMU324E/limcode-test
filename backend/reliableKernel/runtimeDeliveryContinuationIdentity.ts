import {
  requirePhaseFId,
  stablePhaseFId
} from './phaseFIdentity';

export const CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE =
  'application/vnd.limcode.child-runtime-delivery-continuation+json';
export const TURN_EXECUTION_PRESET_CONTENT_TYPE =
  'application/vnd.limcode.turn-execution-preset+json';

export interface ChildRuntimeDeliveryContinuationIdentityInput {
  deliveryId: string;
  childExecutionId: string;
  sourceTurnId: string;
}

/** One persisted identity contract shared by live Child execution and the bounded offline upgrade. */
export function childRuntimeDeliveryContinuationIds(
  input: ChildRuntimeDeliveryContinuationIdentityInput
) {
  const deliveryId = requirePhaseFId(input.deliveryId, 'deliveryId');
  const childExecutionId = requirePhaseFId(input.childExecutionId, 'childExecutionId');
  const sourceTurnId = requirePhaseFId(input.sourceTurnId, 'sourceTurnId');
  const scope = [deliveryId, childExecutionId, sourceTurnId];
  return {
    sourceKey: `runtime-delivery-child:${deliveryId}`,
    commandReceiptId: stablePhaseFId('command_receipt', 'child-runtime-delivery', ...scope),
    turnIntentId: stablePhaseFId('turn_intent', 'child-runtime-delivery', ...scope),
    turnIntentRevisionId: stablePhaseFId('turn_intent_revision', 'child-runtime-delivery', ...scope),
    presetRevisionId: stablePhaseFId('turn_execution_preset_revision', 'child-runtime-delivery', ...scope),
    intentLinkId: stablePhaseFId('child_execution_intent_link', 'child-runtime-delivery', ...scope),
    deliveryIntentLinkId: stablePhaseFId('runtime_delivery_intent_link', 'child-runtime-delivery', ...scope)
  };
}
