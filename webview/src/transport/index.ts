import { createHostApi } from '../platform/createHostApi';
import { WebviewBridge } from './bridge';

type BridgeHostWindow = Window & typeof globalThis & {
  __limcodeBridge?: WebviewBridge;
};

function getOrCreateBridge(): WebviewBridge {
  const limcodeWindow = window as BridgeHostWindow;
  // 缓存到 window，避免 Vite HMR 重新执行模块时重复创建桥或重复注册宿主消息监听。
  limcodeWindow.__limcodeBridge ??= new WebviewBridge(createHostApi());
  return limcodeWindow.__limcodeBridge;
}

/** 全局唯一的协议桥单例。组件不直接引用它，统一通过 stores / composables 间接使用。 */
export const bridge = getOrCreateBridge();

export { WebviewBridge } from './bridge';
export { BridgeMessageType } from '@shared/protocol';
