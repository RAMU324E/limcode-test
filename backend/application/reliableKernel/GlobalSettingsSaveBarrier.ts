import { randomUUID } from 'node:crypto';
import { BridgeMessageType, type GlobalSettingsFlushResultPayload } from '../../../shared/protocol';

interface SettingsClient {
  postMessage(message: unknown): PromiseLike<boolean>;
}

interface PendingFlush {
  remaining: Set<string>;
  finish(error?: Error): void;
}

/** 等待所有已就绪页面提交修改；不承载配置内容，也不替代设置文件的修订检查。 */
export class GlobalSettingsSaveBarrier {
  private readonly clients = new Map<string, SettingsClient>();
  private readonly pending = new Map<string, PendingFlush>();

  public constructor(private readonly timeoutMs = 15_000) {}

  public get hasClients(): boolean { return this.clients.size > 0; }

  public attach(clientId: string, client: SettingsClient): void {
    this.clients.set(clientId, client);
  }

  public detach(clientId: string): void {
    this.clients.delete(clientId);
    for (const pending of this.pending.values()) {
      if (pending.remaining.has(clientId)) pending.finish(new Error('设置确认期间页面已关闭，请确认设置后重试。'));
    }
  }

  public flush(): Promise<void> {
    if (this.clients.size === 0) return Promise.resolve();
    const clients = [...this.clients];
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('等待设置保存确认超时，请检查设置页后重试。')), this.timeoutMs);
      const finish = (error?: Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      this.pending.set(id, { remaining: new Set(clients.map(([clientId]) => clientId)), finish });
      for (const [, client] of clients) {
        Promise.resolve().then(() => client.postMessage({
          id, type: BridgeMessageType.GlobalSettingsFlush, channel: 'settings'
        })).then(
          (delivered) => { if (!delivered) finish(new Error('设置页面未收到保存确认请求，请重新打开该页面后重试。')); },
          () => finish(new Error('无法联系设置页面，请确认设置后重试。'))
        );
      }
    });
  }

  public receive(clientId: string, correlationId: string | undefined, result: GlobalSettingsFlushResultPayload): void {
    const pending = correlationId ? this.pending.get(correlationId) : undefined;
    if (!pending?.remaining.has(clientId)) return;
    if (result.status !== 'saved') {
      pending.finish(new Error(result.message?.trim() || '设置尚未保存，已暂停本次操作。'));
      return;
    }
    pending.remaining.delete(clientId);
    if (pending.remaining.size === 0) pending.finish();
  }
}
