import type { Entity, WorldReader } from '../../../ecs/types';
import type {
  LlmInvocationSettingsSnapshotRecord,
  MessageContent,
  RunContextPolicyRecord
} from '../../../../shared/protocol';
import { projectModelContext } from '../../../modelContext/modelContextProjector';
import type { ModelContextProjection } from '../../../modelContext/types';
import { Conversation, Message } from '../chat/components';
import { CompressionBlock, CompressionContextVariant } from '../compression/components';
import { AgentRun, type RunContextPolicyData } from './components';
import { modelContextTurnFactsFromWorld } from './modelContextWorldFacts';

export interface BuildRunContextInput {
  run: Entity;
  conversation: Entity;
  modelMessage: Entity;
  policy?: RunContextPolicyData;
  settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
  mode?: 'fresh' | 'same_run_resume' | 'dry_run';
}

export interface SelectedRunCompressionContext {
  block: Entity;
  variant: Entity;
  mode: 'provider_native' | 'summary_fallback';
}

/** The only World-facing adapter for turn context selection and materialization. */
export function projectRunModelContext(world: WorldReader, input: BuildRunContextInput): ModelContextProjection {
  const run = world.get(input.run, AgentRun);
  const conversation = world.get(input.conversation, Conversation);
  const modelMessage = world.get(input.modelMessage, Message);
  if (!run || !conversation || !modelMessage) {
    throw new Error(`Cannot project model context from incomplete ECS turn: run=${input.run}, conversation=${input.conversation}, message=${input.modelMessage}.`);
  }
  const policy: RunContextPolicyRecord = input.policy
    ? { ...input.policy }
    : { id: `default-context-policy:${run.id}`, historyMode: 'full' };
  const projection = projectModelContext({
    facts: modelContextTurnFactsFromWorld(world),
    purpose: {
      kind: 'turn',
      mode: input.mode ?? 'fresh',
      turn: {
        conversationId: conversation.id,
        runId: run.id,
        modelMessageId: modelMessage.id
      },
      policy,
      ...(input.settingsSnapshot ? { settingsSnapshot: input.settingsSnapshot } : {})
    }
  });
  const errors = projection.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Model context projection failed for Run ${run.id}: ${errors.map((item) => `${item.code}:${item.message}`).join('; ')}`);
  }
  return projection;
}

export function buildRunContextContents(world: WorldReader, input: BuildRunContextInput): MessageContent[] {
  return projectRunModelContext(world, input).contents;
}

export function selectRunContextMessageEntities(world: WorldReader, input: BuildRunContextInput): Entity[] {
  return projectRunModelContext(world, input).messageSelections.flatMap((selection) => {
    const entity = world.entityByRecordId(Message, selection.messageId);
    return entity === undefined ? [] : [entity];
  });
}

export function selectedRunCompressionContext(
  world: WorldReader,
  input: BuildRunContextInput,
  projection = projectRunModelContext(world, input)
): SelectedRunCompressionContext | undefined {
  const item = projection.items.find((candidate) => candidate.kind === 'compression_variant');
  if (!item || item.kind !== 'compression_variant') return undefined;
  const block = world.entityByRecordId(CompressionBlock, item.blockId);
  const variant = world.entityByRecordId(CompressionContextVariant, item.variantId);
  if (block === undefined || variant === undefined) return undefined;
  return { block, variant, mode: item.mode };
}
