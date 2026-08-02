import { createHostApi } from '@webview/platform/createHostApi';
import type { ExtensionToSidebarMessage, SidebarToExtensionMessage } from './types';

const host = createHostApi();

export interface SidebarHostState {
  expandedConversationIds: string[];
}

export function postSidebarMessage(message: SidebarToExtensionMessage): void {
  host.postMessage(message);
}

export function onSidebarMessage(handler: (message: ExtensionToSidebarMessage) => void): () => void {
  return host.onMessage((raw) => handler(raw as ExtensionToSidebarMessage));
}

export function readSidebarHostState(): SidebarHostState {
  const state = host.getState<unknown>();
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { expandedConversationIds: [] };
  }
  const expanded = (state as { expandedConversationIds?: unknown }).expandedConversationIds;
  return {
    expandedConversationIds: Array.isArray(expanded)
      ? [...new Set(expanded.filter((value): value is string => typeof value === 'string' && value.length > 0))]
      : []
  };
}

export function writeSidebarHostState(state: SidebarHostState): void {
  host.setState<SidebarHostState>({
    expandedConversationIds: [...state.expandedConversationIds]
  });
}
