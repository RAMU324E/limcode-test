import { createHash, randomBytes } from 'node:crypto';
import {
  STABLE_ID_PREFIXES,
  prefixedStableId,
  uuidV7,
  type StableIdFactory,
  type UuidV7Source
} from '../../shared/stableIds';

export class RuntimeStableIdFactory implements StableIdFactory {
  public constructor(private readonly source: UuidV7Source = runtimeUuidV7Source) {}

  public nextConversationId(): ReturnType<StableIdFactory['nextConversationId']> { return this.next('conversation'); }
  public nextMessageId(): ReturnType<StableIdFactory['nextMessageId']> { return this.next('message'); }
  public nextMessageRevisionId(): ReturnType<StableIdFactory['nextMessageRevisionId']> { return this.next('messageRevision'); }
  public nextRunId(): ReturnType<StableIdFactory['nextRunId']> { return this.next('run'); }
  public nextTurnId(): ReturnType<StableIdFactory['nextTurnId']> { return this.next('turn'); }
  public nextTurnIntentId(): ReturnType<StableIdFactory['nextTurnIntentId']> { return this.next('turnIntent'); }
  public nextTurnIntentRevisionId(): ReturnType<StableIdFactory['nextTurnIntentRevisionId']> { return this.next('turnIntentRevision'); }
  public nextPendingTurnInputId(): ReturnType<StableIdFactory['nextPendingTurnInputId']> { return this.next('pendingTurnInput'); }
  public nextExecutionLeaseId(): ReturnType<StableIdFactory['nextExecutionLeaseId']> { return this.next('executionLease'); }
  public nextAuthoritySnapshotId(): ReturnType<StableIdFactory['nextAuthoritySnapshotId']> { return this.next('authoritySnapshot'); }
  public nextRuntimeInboxItemId(): ReturnType<StableIdFactory['nextRuntimeInboxItemId']> { return this.next('runtimeInboxItem'); }
  public nextInteractionResponseId(): ReturnType<StableIdFactory['nextInteractionResponseId']> { return this.next('interactionResponse'); }
  public nextInvocationId(): ReturnType<StableIdFactory['nextInvocationId']> { return this.next('invocation'); }
  public nextRequestId(): ReturnType<StableIdFactory['nextRequestId']> { return this.next('request'); }
  public nextToolCallId(): ReturnType<StableIdFactory['nextToolCallId']> { return this.next('toolCall'); }
  public nextToolCallEventId(): ReturnType<StableIdFactory['nextToolCallEventId']> { return this.next('toolCallEvent'); }
  public nextToolResultArtifactId(): ReturnType<StableIdFactory['nextToolResultArtifactId']> { return this.next('toolResultArtifact'); }
  public nextCheckpointId(): ReturnType<StableIdFactory['nextCheckpointId']> { return this.next('checkpoint'); }
  public nextCompressionId(): ReturnType<StableIdFactory['nextCompressionId']> { return this.next('compression'); }
  public nextContextProjectionId(): ReturnType<StableIdFactory['nextContextProjectionId']> { return this.next('contextProjection'); }
  public nextOperationId(): ReturnType<StableIdFactory['nextOperationId']> { return this.next('operation'); }
  public nextAttemptId(): ReturnType<StableIdFactory['nextAttemptId']> { return this.next('attempt'); }
  public nextCommandId(): ReturnType<StableIdFactory['nextCommandId']> { return this.next('command'); }
  public nextTransitionId(): ReturnType<StableIdFactory['nextTransitionId']> { return this.next('transition'); }
  public nextCallbackEventId(): ReturnType<StableIdFactory['nextCallbackEventId']> { return this.next('callbackEvent'); }
  public nextAnswerBridgeId(): ReturnType<StableIdFactory['nextAnswerBridgeId']> { return this.next('answerBridge'); }
  public nextAnswerSubmissionId(): ReturnType<StableIdFactory['nextAnswerSubmissionId']> { return this.next('answerSubmission'); }
  public nextDeliveryId(): ReturnType<StableIdFactory['nextDeliveryId']> { return this.next('delivery'); }
  public nextEffectIntentId(): ReturnType<StableIdFactory['nextEffectIntentId']> { return this.next('effectIntent'); }
  public nextInteractionRequestId(): ReturnType<StableIdFactory['nextInteractionRequestId']> { return this.next('interactionRequest'); }
  public nextRelationId(): ReturnType<StableIdFactory['nextRelationId']> { return this.next('relation'); }

  private next<TKey extends keyof typeof STABLE_ID_PREFIXES>(kind: TKey): ReturnType<StableIdFactory[`next${Capitalize<TKey>}Id` & keyof StableIdFactory]> {
    return prefixedStableId(STABLE_ID_PREFIXES[kind], uuidV7(this.source)) as ReturnType<StableIdFactory[`next${Capitalize<TKey>}Id` & keyof StableIdFactory]>;
  }
}

const runtimeUuidV7Source: UuidV7Source = {
  now: () => Date.now(),
  randomBytes: (length) => randomBytes(length)
};

/** Stable deterministic source for pure domain and transaction tests. */
export class DeterministicStableIdFactory extends RuntimeStableIdFactory {
  public constructor(input: { startAt?: number; seed?: number } = {}) {
    let now = Math.floor(input.startAt ?? 1_700_000_000_000);
    let state = (input.seed ?? 0x6d2b79f5) >>> 0;
    super({
      now: () => now++,
      randomBytes: (length) => {
        const bytes = new Uint8Array(length);
        for (let index = 0; index < length; index += 1) {
          state += 0x6d2b79f5;
          let value = state;
          value = Math.imul(value ^ value >>> 15, value | 1);
          value ^= value + Math.imul(value ^ value >>> 7, value | 61);
          bytes[index] = (value ^ value >>> 14) & 0xff;
        }
        return bytes;
      }
    });
  }
}

export function stableIdFromSeed<TKey extends keyof typeof STABLE_ID_PREFIXES>(kind: TKey, seed: string): ReturnType<StableIdFactory[`next${Capitalize<TKey>}Id` & keyof StableIdFactory]> {
  if (!seed) throw new Error('Deterministic Stable ID seed cannot be empty.');
  const digest = createHash('sha256').update(kind, 'utf8').update('\0').update(seed, 'utf8').digest();
  const timestamp = digest.subarray(0, 6).reduce((value, byte) => value * 256 + byte, 0);
  const uuid = uuidV7({
    now: () => timestamp,
    randomBytes: (length) => new Uint8Array(digest.subarray(0, length))
  });
  return prefixedStableId(STABLE_ID_PREFIXES[kind], uuid) as ReturnType<StableIdFactory[`next${Capitalize<TKey>}Id` & keyof StableIdFactory]>;
}

export const stableIds = new RuntimeStableIdFactory();

/** Stable UUIDv7 identity for auxiliary records and relationship rows not carrying a branded domain ID. */
export function nextAuxiliaryId(prefix: string): string {
  return prefixedStableId(prefix, uuidV7(runtimeUuidV7Source));
}
