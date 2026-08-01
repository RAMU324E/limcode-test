import type { Pinia } from 'pinia';
import { useReliableKernelClientFeedStore, isReliableKernelFeedDataMessage } from '@webview/stores/useReliableKernelClientFeedStore';
import { bridge } from './index';

let installed = false;

/** Installs the bounded candidate feed alongside the daily pre-cutover route without sharing state. */
export function installReliableKernelClientFeed(pinia: Pinia): void {
  if (installed) return;
  installed = true;
  const store = useReliableKernelClientFeedStore(pinia);
  bridge.onAny((message) => {
    if (isReliableKernelFeedDataMessage(message)) store.observe(message);
  });
}
