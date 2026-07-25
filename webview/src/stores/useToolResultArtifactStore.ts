import { defineStore } from 'pinia';
import type { ToolCallResultLinkRecord, ToolResultArtifactRecord, ToolResultArtifactSnapshotPayload } from '@shared/protocol';
import type { JsonValue } from '@shared/conversationReliability';
import { BridgeMessageType } from '@shared/protocol';
import { bridge } from '@webview/transport';

export interface ToolResultState {
  toolResultArtifacts: readonly ToolResultArtifactRecord[];
  toolCallResultLinks: readonly ToolCallResultLinkRecord[];
}

export interface LoadedToolResult {
  contentHash: string;
  content: JsonValue;
}

interface ToolResultArtifactStoreState {
  loadedByArtifactId: Record<string, LoadedToolResult>;
  pendingByArtifactId: Record<string, string>;
  errorByArtifactId: Record<string, string | undefined>;
}

export const useToolResultArtifactStore = defineStore('tool-result-artifacts', {
  state: (): ToolResultArtifactStoreState => ({
    loadedByArtifactId: {},
    pendingByArtifactId: {},
    errorByArtifactId: {}
  }),

  actions: {
    ensureFullResult(conversationId: string, artifact: ToolResultArtifactRecord | undefined): void {
      if (!artifact || artifact.storageKind !== 'blob') return;
      const loaded = this.loadedByArtifactId[artifact.id];
      if (loaded?.contentHash === artifact.contentHash || this.pendingByArtifactId[artifact.id]) return;
      const requestId = bridge.request(BridgeMessageType.ToolResultArtifactGet, {
        conversationId,
        artifactId: artifact.id
      }, { channel: 'state', scope: { kind: 'conversation', id: conversationId } });
      this.pendingByArtifactId[artifact.id] = requestId;
      this.errorByArtifactId[artifact.id] = undefined;
    },

    applySnapshot(payload: ToolResultArtifactSnapshotPayload): void {
      this.loadedByArtifactId[payload.artifactId] = {
        contentHash: payload.contentHash,
        content: cloneJson(payload.content)
      };
      delete this.pendingByArtifactId[payload.artifactId];
      this.errorByArtifactId[payload.artifactId] = undefined;
    },

    applyError(artifactId: string, message: string): void {
      delete this.pendingByArtifactId[artifactId];
      this.errorByArtifactId[artifactId] = message;
    },

    applyRequestError(requestId: string | undefined, message: string): boolean {
      if (!requestId) return false;
      const artifactId = Object.entries(this.pendingByArtifactId)
        .find(([, pendingRequestId]) => pendingRequestId === requestId)?.[0];
      if (!artifactId) return false;
      this.applyError(artifactId, message);
      return true;
    }
  }
});

export function finalToolResultArtifact(state: ToolResultState, toolCallId: string): ToolResultArtifactRecord | undefined {
  const links = state.toolCallResultLinks.filter((link) => link.toolCallId === toolCallId && link.role === 'final');
  if (links.length !== 1) return undefined;
  return state.toolResultArtifacts.find((artifact) => artifact.id === links[0]!.artifactId);
}

export function toolResultForState(
  state: ToolResultState,
  toolCallId: string,
  loadedByArtifactId: Readonly<Record<string, LoadedToolResult>> = {}
): JsonValue | undefined {
  const artifact = finalToolResultArtifact(state, toolCallId);
  if (!artifact) return undefined;
  const loaded = loadedByArtifactId[artifact.id];
  if (loaded?.contentHash === artifact.contentHash) return cloneJson(loaded.content);
  if (artifact.storageKind === 'inline' && artifact.inlineContent !== undefined) return cloneJson(artifact.inlineContent);
  return {
    truncated: true,
    byteLength: artifact.byteLength,
    preview: artifact.preview
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
