import type {
  CleanupHint,
  JsonValue,
  PlannedPatchBatch,
  PrimaryEffectDescriptor,
  RecordMutation,
  TransitionPlan
} from '../../../shared/conversationReliability';
import type { CommandId, ConversationId, TransitionId } from '../../../shared/stableIds';
import type { DurableRecordFamily } from './types';

export class ConversationTransitionBuilder {
  private readonly mutations: RecordMutation[] = [];
  private readonly generated = new Set<string>();
  private readonly effects: PrimaryEffectDescriptor[] = [];
  private readonly cleanup: CleanupHint[] = [];
  private readonly patchOperations = new Map<ConversationId, JsonValue[]>();

  public constructor(
    private readonly input: {
      transitionId: TransitionId;
      commandId?: CommandId;
      scopes: readonly ConversationId[];
      baseVersions: ReadonlyMap<ConversationId, number>;
      streamHeads: ReadonlyMap<ConversationId, { streamId: string; nextSeq: number }>;
    }
  ) {}

  public upsert(family: DurableRecordFamily, record: { id: string } | Record<string, unknown>): this {
    const id = 'id' in record && typeof record.id === 'string' ? record.id : undefined;
    if (!id) throw new Error(`Upsert in ${family} has no Stable ID.`);
    this.mutations.push({ kind: 'upsert', family, id, record: asJson(record) });
    return this;
  }

  public remove(family: DurableRecordFamily, id: string): this {
    this.mutations.push({ kind: 'remove', family, id });
    return this;
  }

  public removeMany(family: DurableRecordFamily, ids: Iterable<string>): this {
    const unique = [...new Set(ids)].sort();
    if (unique.length > 0) this.mutations.push({ kind: 'remove_many', family, ids: unique });
    return this;
  }

  public generatedId(...ids: string[]): this {
    for (const id of ids) {
      if (!id) throw new Error('Generated Stable ID cannot be empty.');
      if (this.generated.has(id)) throw new Error(`Generated Stable ID is duplicated: ${id}`);
      this.generated.add(id);
    }
    return this;
  }

  public primaryEffect(effect: PrimaryEffectDescriptor): this {
    this.effects.push(effect);
    return this;
  }

  public cleanupHint(hint: CleanupHint): this {
    this.cleanup.push(hint);
    return this;
  }

  public patch(conversationId: ConversationId, operation: unknown): this {
    const operations = this.patchOperations.get(conversationId) ?? [];
    operations.push(asJson(operation));
    this.patchOperations.set(conversationId, operations);
    return this;
  }

  public build<TResult extends JsonValue>(result: TResult): TransitionPlan<TResult> {
    const scopes = [...new Set(this.input.scopes)].sort();
    const patches: PlannedPatchBatch[] = scopes.map((conversationId) => {
      const head = this.input.streamHeads.get(conversationId) ?? {
        streamId: `conversation:${conversationId}:state`,
        nextSeq: 0
      };
      const operations = this.patchOperations.get(conversationId) ?? [];
      return {
        conversationId,
        streamId: head.streamId,
        baseSeq: head.nextSeq,
        nextSeq: head.nextSeq + 1,
        operations
      };
    });
    return {
      transitionId: this.input.transitionId,
      scopes,
      baseVersions: scopes.map((conversationId) => ({
        conversationId,
        version: requireMapValue(this.input.baseVersions, conversationId, 'baseVersion')
      })),
      nextVersions: scopes.map((conversationId) => ({
        conversationId,
        version: requireMapValue(this.input.baseVersions, conversationId, 'baseVersion') + 1
      })),
      recordMutations: this.mutations,
      generatedIds: [...this.generated],
      primaryEffectDescriptors: this.effects,
      cleanupHints: this.cleanup,
      patches,
      result
    };
  }
}

export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function requireMapValue(map: ReadonlyMap<ConversationId, number>, key: ConversationId, label: string): number {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing ${label} for ${key}.`);
  return value;
}
