import type { ClientPatchOp, ClientState, ConversationHeadSnapshotPayload, LlmTransientNoticePayload } from '../../../shared/protocol';
import type { TransientStreamEpoch } from '../../../shared/conversationReliability';

export interface ClientSnapshotEffect {
  kind: 'client.snapshot';
  streamId: string;
  /** 当前 state stream 的顺序号，不是协议版本。 */
  streamSeq: number;
  state: ClientState;
  conversationHead?: ConversationHeadSnapshotPayload;
}

export interface ClientPatchEffect {
  kind: 'client.patch';
  streamId: string;
  /** 当前 state stream 的顺序号，不是协议版本。 */
  streamSeq: number;
  patches: ClientPatchOp[];
  /** Reliable transient patches are admitted only while this Attempt generation is live. */
  transientStreamEpoch?: TransientStreamEpoch;
}

export interface ClientTransientNoticeEffect {
  kind: 'client.transientNotice';
  streamId: string;
  payload: LlmTransientNoticePayload;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'client.snapshot': ClientSnapshotEffect;
    'client.patch': ClientPatchEffect;
    'client.transientNotice': ClientTransientNoticeEffect;
  }
}
