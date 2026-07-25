import { estimateTokenCount } from 'tokenx';
import type {
  CheckpointPolicyRecord,
  CheckpointTriggerKind,
  ContentPart,
  MessageContent
} from '../../shared/protocol';
import {
  isFunctionCallPart,
  isFunctionResponsePart,
  isProviderContextPart,
  isTextPart
} from '../../shared/protocol';
import type { AttemptId, ConversationId, MessageId, RunId } from '../../shared/stableIds';
import { CHECKPOINT_FEATURE_ENABLED } from '../../shared/featureFlags';
import type { WorldReader } from '../ecs/types';
import { AgentRun } from '../world/modules/agentRun/components';
import { Conversation, Message } from '../world/modules/chat/components';
import {
  shadowRepositoryIdFor,
  shadowRepositoryStorageKeyFor
} from '../world/modules/checkpoint/bundles';
import { effectiveCheckpointPolicyForRequest } from '../world/modules/checkpoint/queries';
import { compressionThresholdTokens } from '../world/modules/llm/usage';
import type { LlmStartRequest } from '../world/modules/llm/contracts';
import { ConversationProjectLink, ProjectContext } from '../world/modules/project/components';
import { canonicalSha256 } from './canonicalJson';
import type { DurableConversationFacts } from './domain/types';
import { planReliableAutoCompressionProjection } from './reliableAutoCompressionPlanner';
import type {
  ReliableCheckpointBarrierPlan,
  ReliableCompressionBarrierPlan,
  ReliableContextBuildInput,
  ReliableLlmPreflightStep,
  ReliableProgressIds
} from './domain/preflightTypes';
import { stableIdFromSeed } from './stableIdFactory';

export interface ReliablePreflightToken {
  conversationId: ConversationId;
  ownerRunId: RunId;
  attemptId: AttemptId;
  generation: number;
}

/** Computes one explicit pre-LLM barrier from committed facts and the current projected policy. */
export function planReliableLlmPreflight(
  world: WorldReader,
  facts: DurableConversationFacts,
  token: ReliablePreflightToken,
  input: ReliableContextBuildInput,
  request: LlmStartRequest
): ReliableLlmPreflightStep {
  const seed = `${token.attemptId}:${token.generation}:${request.id}`;
  if (!input.skipCompression) {
    const compression = planCompression(facts, request, seed);
    if (compression) {
      return {
        kind: 'compression',
        ids: progressIds(`${seed}:compression`),
        plan: compression,
        continuation: {
          kind: 'context_rebuild',
          ids: progressIds(`${seed}:post-compression-context`),
          input: { ...input, skipCompression: true }
        }
      };
    }
  }

  const checkpoint = planReliableCheckpointBarrier(world, facts, token, input.modelMessageId, 'llm_response_before', seed);
  if (checkpoint) {
    return {
      kind: 'checkpoint',
      ids: progressIds(`${seed}:checkpoint`),
      plan: checkpoint,
      continuation: {
        kind: 'llm_request',
        ids: progressIds(`${seed}:post-checkpoint-request`),
        request
      }
    };
  }

  return { kind: 'llm_request', ids: progressIds(`${seed}:request`), request };
}

function planCompression(
  facts: DurableConversationFacts,
  request: LlmStartRequest,
  seed: string
): ReliableCompressionBarrierPlan | undefined {
  const settings = request.settingsSnapshot;
  const methodKind = settings?.compressionMethodKind;
  if (!settings || !methodKind || methodKind === 'disabled' || methodKind === 'manual_summary') return undefined;

  const estimatedTokens = estimateRequestTokens(request);
  const thresholdTokens = compressionThresholdTokens(settings);
  const contextWindowTokens = positiveInteger(settings.contextWindowTokens);
  const thresholdReached = settings.compressionTrigger?.mode === 'token_threshold'
    && thresholdTokens !== undefined
    && estimatedTokens >= thresholdTokens;
  const contextWindowRisk = contextWindowTokens !== undefined && estimatedTokens >= Math.floor(contextWindowTokens * 0.95);
  if (!thresholdReached && !contextWindowRisk) return undefined;

  const requestFact = facts.requests.find((candidate) => candidate.id === request.id);
  if (!requestFact?.modelMessageId) return undefined;
  const planned = planReliableAutoCompressionProjection(facts, {
    settings,
    sourceTurn: {
      conversationId: facts.conversation.id,
      runId: requestFact.runId,
      invocationId: requestFact.invocationId,
      requestId: requestFact.id,
      modelMessageId: requestFact.modelMessageId
    },
    includeSourceTurnMessage: false,
    seed,
    now: facts.turns.find((run) => run.id === requestFact.runId)?.updatedAt
      ?? facts.messages.reduce((latest, message) => Math.max(latest, message.createdAt), 1)
  });
  return planned.kind === 'ready' ? planned.plan : undefined;
}



export function planReliableCheckpointBarrier(
  world: WorldReader,
  facts: DurableConversationFacts,
  token: ReliablePreflightToken,
  anchorMessageId: MessageId,
  trigger: Extract<CheckpointTriggerKind, 'llm_response_before' | 'llm_response_after' | 'tool_execution_before' | 'tool_execution_after'>,
  seed: string,
  toolName?: string
): ReliableCheckpointBarrierPlan | undefined {
  if (!CHECKPOINT_FEATURE_ENABLED) return undefined;
  const conversationEntity = world.entityByRecordId(Conversation, token.conversationId);
  const runEntity = world.entityByRecordId(AgentRun, token.ownerRunId);
  if (conversationEntity === undefined || runEntity === undefined) return undefined;
  const resolution = effectiveCheckpointPolicyForRequest(world, { conversation: conversationEntity, run: runEntity });
  if (!resolution.policy.enabled || !checkpointTriggerEnabled(resolution.policy, trigger, toolName)) return undefined;

  const projectLinks = world.query(ConversationProjectLink)
    .map((entity) => world.get(entity, ConversationProjectLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.conversation === conversationEntity && link.role === 'primary');
  if (projectLinks.length > 1) throw new Error(`Conversation ${token.conversationId} has ambiguous primary project ownership.`);
  const project = projectLinks[0] ? world.get(projectLinks[0].projectContext, ProjectContext) : undefined;
  if (!project) return undefined;

  const repositoryId = shadowRepositoryIdFor(token.conversationId, project.uri);
  const existingRepository = facts.shadowRepositories.find((record) => record.id === repositoryId);
  const existingLink = facts.conversationCheckpointRepositoryLinks.find((record) => record.conversationId === token.conversationId
    && record.projectContextId === project.id
    && record.shadowRepositoryId === repositoryId);
  const checkpointId = stableIdFromSeed('checkpoint', `${seed}:${trigger}:${anchorMessageId}`);
  const createdAt = Math.max(1, facts.turns.find((run) => run.id === token.ownerRunId)?.updatedAt ?? 1);
  const repository = {
    id: repositoryId,
    storageKey: shadowRepositoryStorageKeyFor(token.conversationId, project.uri),
    createdAt: existingRepository?.createdAt ?? createdAt,
    updatedAt: createdAt
  };
  const repositoryLink = {
    id: existingLink?.id ?? stableIdFromSeed('relation', `${seed}:checkpoint-repository:${project.id}`),
    conversationId: token.conversationId,
    projectContextId: project.id,
    shadowRepositoryId: repositoryId,
    projectUri: project.uri,
    projectDisplayPath: project.name || project.uri,
    role: 'active' as const,
    createdAt: existingLink?.createdAt ?? createdAt,
    updatedAt: createdAt
  };
  const checkpoint = {
    id: checkpointId,
    conversationId: token.conversationId,
    projectContextId: project.id,
    shadowRepositoryId: repositoryId,
    trigger,
    status: 'pending' as const,
    projectUri: project.uri,
    projectDisplayPath: project.name || project.uri,
    createdAt,
    updatedAt: createdAt
  };
  const anchor = {
    id: stableIdFromSeed('relation', `${seed}:checkpoint-anchor:${checkpointId}`),
    conversationId: token.conversationId,
    checkpointId,
    floorMessageId: anchorMessageId,
    position: trigger.endsWith('_before') ? 'before' as const : 'after' as const,
    order: createdAt,
    sourceRunId: token.ownerRunId,
    createdAt,
    updatedAt: createdAt
  };
  return {
    repository,
    repositoryLink,
    checkpoint,
    anchor,
    createRequest: {
      checkpointId,
      conversationId: token.conversationId,
      projectContextId: project.id,
      projectUri: project.uri,
      projectDisplayPath: project.name || project.uri,
      shadowRepositoryId: repositoryId,
      shadowRepositoryStorageKey: repository.storageKey,
      trigger: checkpoint.trigger,
      policy: clone(resolution.policy)
    }
  };
}

function checkpointTriggerEnabled(
  policy: CheckpointPolicyRecord,
  trigger: Extract<CheckpointTriggerKind, 'llm_response_before' | 'llm_response_after' | 'tool_execution_before' | 'tool_execution_after'>,
  toolName?: string
): boolean {
  switch (trigger) {
    case 'llm_response_before': return policy.triggers.llmResponseBefore === true;
    case 'llm_response_after': return policy.triggers.llmResponseAfter === true;
    case 'tool_execution_before': return !!toolName && policy.toolTriggers[toolName]?.before === true;
    case 'tool_execution_after': return !!toolName && policy.toolTriggers[toolName]?.after === true;
  }
}

function progressIds(seed: string): ReliableProgressIds {
  return {
    operationId: stableIdFromSeed('operation', `${seed}:operation`),
    attemptId: stableIdFromSeed('attempt', `${seed}:attempt`),
    effectIntentId: stableIdFromSeed('effectIntent', `${seed}:effect`)
  };
}


function estimateRequestTokens(request: LlmStartRequest): number {
  return estimateContentsTokens([
    ...(request.systemInstruction ? [request.systemInstruction] : []),
    ...request.contents
  ]);
}

function estimateContentsTokens(contents: readonly MessageContent[]): number {
  const text = contents.flatMap((content) => content.parts.map(renderPart)).join('\n');
  const estimated = estimateTokenCount(text);
  return Number.isFinite(estimated) ? Math.max(0, estimated) : 0;
}

function renderPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[tool call] ${part.functionCall.name}: ${JSON.stringify(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[tool result] ${part.functionResponse.name}: ${JSON.stringify(part.functionResponse.response)}`;
  if (isProviderContextPart(part)) return `[provider context] ${part.providerContext.format}`;
  return '';
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
