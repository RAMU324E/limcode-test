import { defineStore } from 'pinia';
import {
  RELIABLE_KERNEL_CHANGES_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
  applyReliableKernelDataMessage,
  createEmptyReliableKernelClientState,
  type ReliableKernelBoundedClientState
} from '@shared/reliableKernelClientFeed';
import { bridge } from '@webview/transport';

export const useReliableKernelClientFeedStore = defineStore('reliableKernelClientFeed', {
  state: (): ReliableKernelBoundedClientState => createEmptyReliableKernelClientState(),
  getters: {
    childExecutionFacts: (state) => Object.values(state.records.ChildExecution ?? {}),
    activeChildTurnFacts: (state) => Object.values(state.records.ChildExecutionActiveTurnLink ?? {}),
    answerSubmissionFacts: (state) => Object.values(state.records.AnswerSubmission ?? {}),
    runtimeDeliveryFacts: (state) => Object.values(state.records.RuntimeDelivery ?? {}),
    terminationFacts: (state) => Object.values(state.records.TurnTermination ?? {})
  },
  actions: {
    observe(message: unknown): void {
      const result = applyReliableKernelDataMessage(this.$state, message);
      this.sessionId = result.state.sessionId;
      this.hostBootId = result.state.hostBootId;
      this.lastCommitSeq = result.state.lastCommitSeq;
      this.projections = result.state.projections;
      this.records = result.state.records;
      this.snapshotRequired = result.state.snapshotRequired;
      if (result.ack) bridge.postRaw(result.ack);
      if (result.snapshotRequired) {
        bridge.postRaw({
          type: RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
          ...(this.sessionId ? { sessionId: this.sessionId } : {})
        });
      }
    }
  }
});

export function isReliableKernelFeedDataMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const type = (message as Record<string, unknown>).type;
  return type === RELIABLE_KERNEL_SNAPSHOT_MESSAGE || type === RELIABLE_KERNEL_CHANGES_MESSAGE;
}
