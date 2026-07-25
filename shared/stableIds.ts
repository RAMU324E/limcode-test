declare const stableIdBrand: unique symbol;

export type StableId<TName extends string> = string & {
  readonly [stableIdBrand]: TName;
};

export type ConversationId = StableId<'ConversationId'>;
export type MessageId = StableId<'MessageId'>;
export type MessageRevisionId = StableId<'MessageRevisionId'>;
export type RunId = StableId<'RunId'>;
export type TurnId = StableId<'TurnId'>;
export type TurnIntentId = StableId<'TurnIntentId'>;
export type TurnIntentRevisionId = StableId<'TurnIntentRevisionId'>;
export type PendingTurnInputId = StableId<'PendingTurnInputId'>;
export type ExecutionLeaseId = StableId<'ExecutionLeaseId'>;
export type AuthoritySnapshotId = StableId<'AuthoritySnapshotId'>;
export type RuntimeInboxItemId = StableId<'RuntimeInboxItemId'>;
export type InteractionResponseId = StableId<'InteractionResponseId'>;
export type InvocationId = StableId<'InvocationId'>;
export type RequestId = StableId<'RequestId'>;
export type ToolCallId = StableId<'ToolCallId'>;
export type ToolCallEventId = StableId<'ToolCallEventId'>;
export type ToolResultArtifactId = StableId<'ToolResultArtifactId'>;
export type CheckpointId = StableId<'CheckpointId'>;
export type CompressionId = StableId<'CompressionId'>;
export type ContextProjectionId = StableId<'ContextProjectionId'>;
export type OperationId = StableId<'OperationId'>;
export type AttemptId = StableId<'AttemptId'>;
export type CommandId = StableId<'CommandId'>;
export type TransitionId = StableId<'TransitionId'>;
export type CallbackEventId = StableId<'CallbackEventId'>;
export type AnswerBridgeId = StableId<'AnswerBridgeId'>;
export type AnswerSubmissionId = StableId<'AnswerSubmissionId'>;
export type DeliveryId = StableId<'DeliveryId'>;
export type EffectIntentId = StableId<'EffectIntentId'>;
export type InteractionRequestId = StableId<'InteractionRequestId'>;
export type RelationId = StableId<'RelationId'>;

export const STABLE_ID_PREFIXES = {
  conversation: 'conv',
  message: 'msg',
  messageRevision: 'rev',
  run: 'run',
  turn: 'trn',
  turnIntent: 'tni',
  turnIntentRevision: 'tir',
  pendingTurnInput: 'pti',
  executionLease: 'lss',
  authoritySnapshot: 'aut',
  runtimeInboxItem: 'inb',
  interactionResponse: 'ixs',
  invocation: 'inv',
  request: 'req',
  toolCall: 'tool',
  toolCallEvent: 'tce',
  toolResultArtifact: 'tra',
  checkpoint: 'chk',
  compression: 'cmp',
  contextProjection: 'ctx',
  operation: 'op',
  attempt: 'att',
  command: 'cmd',
  transition: 'txn',
  callbackEvent: 'evt',
  answerBridge: 'brg',
  answerSubmission: 'ans',
  delivery: 'dlv',
  effectIntent: 'eff',
  interactionRequest: 'ixr',
  relation: 'rel'
} as const;

export type StableIdKind = keyof typeof STABLE_ID_PREFIXES;

export interface StableIdFactory {
  nextConversationId(): ConversationId;
  nextMessageId(): MessageId;
  nextMessageRevisionId(): MessageRevisionId;
  nextRunId(): RunId;
  nextTurnId(): TurnId;
  nextTurnIntentId(): TurnIntentId;
  nextTurnIntentRevisionId(): TurnIntentRevisionId;
  nextPendingTurnInputId(): PendingTurnInputId;
  nextExecutionLeaseId(): ExecutionLeaseId;
  nextAuthoritySnapshotId(): AuthoritySnapshotId;
  nextRuntimeInboxItemId(): RuntimeInboxItemId;
  nextInteractionResponseId(): InteractionResponseId;
  nextInvocationId(): InvocationId;
  nextRequestId(): RequestId;
  nextToolCallId(): ToolCallId;
  nextToolCallEventId(): ToolCallEventId;
  nextToolResultArtifactId(): ToolResultArtifactId;
  nextCheckpointId(): CheckpointId;
  nextCompressionId(): CompressionId;
  nextContextProjectionId(): ContextProjectionId;
  nextOperationId(): OperationId;
  nextAttemptId(): AttemptId;
  nextCommandId(): CommandId;
  nextTransitionId(): TransitionId;
  nextCallbackEventId(): CallbackEventId;
  nextAnswerBridgeId(): AnswerBridgeId;
  nextAnswerSubmissionId(): AnswerSubmissionId;
  nextDeliveryId(): DeliveryId;
  nextEffectIntentId(): EffectIntentId;
  nextInteractionRequestId(): InteractionRequestId;
  nextRelationId(): RelationId;
}

export interface UuidV7Source {
  now(): number;
  randomBytes(length: number): Uint8Array;
}

/**
 * Formats an RFC 9562 UUIDv7 from an injected clock and random source.
 * Randomness is injected so production and deterministic tests share exactly the same formatter.
 */
export function uuidV7(source: UuidV7Source): string {
  const timestamp = Math.max(0, Math.min(0xffffffffffff, Math.floor(source.now())));
  const bytes = source.randomBytes(16);
  if (bytes.length !== 16) throw new Error(`UUIDv7 random source returned ${bytes.length} bytes; expected 16.`);

  bytes[0] = Math.floor(timestamp / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(timestamp / 0x100000000) & 0xff;
  bytes[2] = Math.floor(timestamp / 0x1000000) & 0xff;
  bytes[3] = Math.floor(timestamp / 0x10000) & 0xff;
  bytes[4] = Math.floor(timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function prefixedStableId<TName extends string>(prefix: string, uuid: string): StableId<TName> {
  if (!/^[a-z][a-z0-9]*$/.test(prefix)) throw new Error(`Invalid Stable ID prefix: ${prefix}`);
  if (!isUuidV7(uuid)) throw new Error(`Invalid UUIDv7: ${uuid}`);
  return `${prefix}_${uuid}` as StableId<TName>;
}

export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isStableId(value: string, kind?: StableIdKind): boolean {
  const separator = value.indexOf('_');
  if (separator <= 0) return false;
  const prefix = value.slice(0, separator);
  if (kind !== undefined && prefix !== STABLE_ID_PREFIXES[kind]) return false;
  return isUuidV7(value.slice(separator + 1));
}

export function requireStableId<TName extends string>(value: string, kind: StableIdKind): StableId<TName> {
  if (!isStableId(value, kind)) throw new Error(`Expected ${kind} Stable ID, received: ${value}`);
  return value as StableId<TName>;
}
