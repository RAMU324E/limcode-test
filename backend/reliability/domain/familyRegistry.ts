import type { DurableRecordFamily } from './types';

/**
 * Exhaustive canonical registry for every durable Conversation fact family read by full control
 * transitions. Keeping one registry prevents command, hydration and projection paths from silently
 * omitting a newly introduced control-plane family.
 */
export const DURABLE_CONVERSATION_RECORD_FAMILIES = [
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'modelContextProjections',
  'modelContextProjectionSourceLinks',
  'requestModelContextProjectionLinks',
  'compressionModelContextProjectionLinks',
  'turns',
  'turnIntents',
  'turnIntentRevisions',
  'turnExecutionPresetRevisions',
  'pendingTurnInputs',
  'executionLeases',
  'authoritySnapshots',
  'authorityDerivationLinks',
  'runtimeInboxItems',
  'runtimeDeliveryLinks',
  'childTurnLinks',
  'messageTurnLinks',
  'interactionOwnerLinks',
  'interactionResponses',
  'runTerminations',
  'runContextPolicies',
  'runContextPolicyLinks',
  'runSources',
  'runTargets',
  'toolRunLinks',
  'inputRevisions',
  'contextSnapshots',
  'invocations',
  'requests',
  'toolCalls',
  'toolCallEvents',
  'toolResultArtifacts',
  'toolCallResultLinks',
  'toolExecutions',
  'compressionBlocks',
  'compressionBlockSourceLinks',
  'compressionContextVariants',
  'compressionBlockLlmInvocationLinks',
  'runCompressionBlockLinks',
  'projectContexts',
  'shadowRepositories',
  'conversationCheckpointRepositoryLinks',
  'checkpoints',
  'checkpointTimelineAnchors',
  'operations',
  'attempts',
  'primaryEffects',
  'effectPayloads',
  'interactionRequests',
  'pauses',
  'operationResolutions',
  'answerBridges',
  'answerSubmissions',
  'answerPayloads',
  'streamCheckpointHeads',
  'terminalStreamFences'
] as const satisfies readonly DurableRecordFamily[];

export function durableConversationRecordFamilies(): DurableRecordFamily[] {
  return [...DURABLE_CONVERSATION_RECORD_FAMILIES];
}
