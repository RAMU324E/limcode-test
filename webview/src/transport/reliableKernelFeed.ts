import type { Pinia } from 'pinia';
import { useReliableKernelClientFeedStore, isReliableKernelFeedMessage } from '@webview/stores/useReliableKernelClientFeedStore';
import { bridge } from './index';

let installed = false;

/** 安装唯一 bounded Runtime Feed；业务视图只通过 store/selectors 消费其纯数据。 */
export function installReliableKernelClientFeed(pinia: Pinia): void {
  if (installed) return;
  installed = true;
  const store = useReliableKernelClientFeedStore(pinia);
  bridge.onAny((message) => {
    if (isReliableKernelFeedMessage(message)) store.observe(message);
  });
}
