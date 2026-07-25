import type { CommittedConversationHead, TerminalStreamFence } from './conversationReliability';

export interface ObservedConversationHead {
  version: number;
  streamId: string;
  patchNextSeq: number;
}

export interface CommittedPatchHeadInput {
  conversationId: string;
  streamId: string;
  baseSeq: number;
  nextSeq: number;
  conversationVersion: number;
}

export type PatchHeadDecision =
  | { status: 'accepted'; head: ObservedConversationHead }
  | { status: 'already_observed'; head: ObservedConversationHead }
  | { status: 'resync_required'; reason: 'stream_changed' | 'sequence_gap' };

export interface PendingVersionReservation {
  conversationId: string;
  expectedVersion: number;
  excluded?: boolean;
  controlHeads?: readonly CommittedConversationHead[];
}

export interface StreamEpochIdentity {
  requestId: string;
  attemptId: string;
  generation: number;
}

export function streamEpochIdentityKey(epoch: StreamEpochIdentity): string {
  return JSON.stringify([epoch.requestId, epoch.attemptId, epoch.generation]);
}

export function streamEpochIsTerminal(
  epoch: StreamEpochIdentity,
  terminalFences: Readonly<Record<string, TerminalStreamFence | undefined>>
): boolean {
  return terminalFences[streamEpochIdentityKey(epoch)] !== undefined;
}

export function advancePatchHead(
  current: ObservedConversationHead | undefined,
  patch: CommittedPatchHeadInput
): PatchHeadDecision {
  const observed = current ?? { version: 0, streamId: patch.streamId, patchNextSeq: 0 };
  if (patch.streamId !== observed.streamId && observed.patchNextSeq > 0) {
    return { status: 'resync_required', reason: 'stream_changed' };
  }
  if (patch.streamId === observed.streamId
    && patch.nextSeq <= observed.patchNextSeq
    && patch.conversationVersion <= observed.version) {
    return { status: 'already_observed', head: observed };
  }
  if (patch.baseSeq !== observed.patchNextSeq) {
    return { status: 'resync_required', reason: 'sequence_gap' };
  }
  return {
    status: 'accepted',
    head: {
      version: patch.conversationVersion,
      streamId: patch.streamId,
      patchNextSeq: patch.nextSeq
    }
  };
}

export function projectionBarrierForConversation(
  conversationId: string,
  projectionHeads: readonly CommittedConversationHead[]
): CommittedConversationHead | undefined {
  const matches = projectionHeads.filter((head) => head.conversationId === conversationId);
  if (matches.length > 1) throw new Error(`Command projection contains duplicate barriers for ${conversationId}.`);
  return matches[0];
}

export function projectionWaitDisposition(input: {
  reached: boolean;
  now: number;
  committedAt: number;
  deadlineMs: number;
}): 'settled' | 'waiting' | 'recovery_required' {
  if (input.reached) return 'settled';
  return input.now - input.committedAt >= input.deadlineMs ? 'recovery_required' : 'waiting';
}

export function initiatingProjectionReached(
  observed: Readonly<Record<string, ObservedConversationHead | undefined>>,
  initiatingConversationId: string,
  projectionHeads: readonly CommittedConversationHead[]
): boolean {
  const barrier = projectionBarrierForConversation(initiatingConversationId, projectionHeads);
  return !barrier || headReached(observed, [barrier]);
}

export function headReached(
  observed: Readonly<Record<string, ObservedConversationHead | undefined>>,
  required: readonly CommittedConversationHead[]
): boolean {
  return required.length > 0 && required.every((head) => {
    const current = observed[head.conversationId];
    return !!current
      && current.version >= head.version
      && current.streamId === head.streamId
      && current.patchNextSeq >= head.patchNextSeq;
  });
}

export function reserveNextExpectedVersion(
  conversationId: string,
  observedVersion: number,
  pending: readonly PendingVersionReservation[]
): number {
  let version = observedVersion;
  for (const command of pending) {
    if (command.excluded || command.conversationId !== conversationId) continue;
    version = Math.max(version, command.expectedVersion + 1);
    for (const head of command.controlHeads ?? []) {
      if (head.conversationId === conversationId) version = Math.max(version, head.version);
    }
  }
  return version;
}

export function conversationIdForStateStream(streamId: string): string | undefined {
  const prefix = 'conversation:';
  const suffix = ':state';
  return streamId.startsWith(prefix) && streamId.endsWith(suffix)
    ? streamId.slice(prefix.length, -suffix.length)
    : undefined;
}

export function snapshotHeadMatchesStream(
  conversationId: string,
  streamId: string,
  head: { conversationId: string; streamId: string }
): boolean {
  return head.conversationId === conversationId && head.streamId === streamId;
}

export function rejectedCommandDisposition(hasCommittedPrerequisite: boolean): 'discard' | 'partial_success' {
  return hasCommittedPrerequisite ? 'partial_success' : 'discard';
}
