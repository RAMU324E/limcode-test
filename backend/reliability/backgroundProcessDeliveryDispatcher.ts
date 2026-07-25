import type { BackgroundProcessManager } from '../capabilities/backgroundProcessManager';
import type { BackgroundProcessDeliveryEnvelope } from '../capabilities/backgroundProcessTypes';

const RETRY_DELAY_MS = 1_000;
const RECONCILIATION_INTERVAL_MS = 1_000;

export interface BackgroundProcessDeliveryTarget {
  deliverBackgroundProcessExit(
    envelope: BackgroundProcessDeliveryEnvelope
  ): Promise<{ status: 'delivered' } | { status: 'stale'; reason: string }>;
}

export interface BackgroundProcessDeliveryDispatcherOptions {
  processes: BackgroundProcessManager;
  target: BackgroundProcessDeliveryTarget;
  onError?: (error: unknown) => void;
}

/**
 * Level-triggered outbox dispatcher. Completion callbacks only create persistent pending rows;
 * this service repeatedly reconciles those rows into the reliable conversation transaction log.
 */
export class BackgroundProcessDeliveryDispatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private scanPromise: Promise<void> | undefined;
  private scanRequested = false;
  private disposed = false;

  public constructor(private readonly options: BackgroundProcessDeliveryDispatcherOptions) {}

  public start(): void {
    if (this.disposed) throw new Error('BackgroundProcessDeliveryDispatcher is disposed.');
    this.unsubscribe ??= this.options.processes.onDeliveryAvailable(() => this.wake());
    this.wake();
  }

  public wake(): void {
    if (this.disposed) return;
    this.scanRequested = true;
    if (this.scanPromise) return;
    this.clearTimer();
    this.scheduleScan(0);
  }

  public async reconcileNow(): Promise<void> {
    if (this.disposed) return;
    this.scanRequested = true;
    if (!this.scanPromise) {
      this.clearTimer();
      this.launchScan();
    }
    await this.scanPromise;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearTimer();
    await this.scanPromise;
  }

  private launchScan(): void {
    if (this.disposed || this.scanPromise) return;
    this.scanPromise = this.scan()
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        this.scanPromise = undefined;
        if (!this.disposed && !this.timer) this.scheduleScan(this.scanRequested ? 0 : RECONCILIATION_INTERVAL_MS);
      });
  }

  private async scan(): Promise<void> {
    while (!this.disposed && this.scanRequested) {
      this.scanRequested = false;
      const deliveryIds = this.options.processes.listPendingDeliveryIds();
      let retryNeeded = false;
      for (const deliveryId of deliveryIds) {
        if (this.disposed) return;
        const resolution = this.options.processes.resolveDelivery(deliveryId);
        if (!resolution) continue;
        if (resolution.status === 'stale') {
          this.options.processes.markDeliveryStale(deliveryId, resolution.reason);
          continue;
        }

        try {
          const claim = this.options.processes.claimDeliveryForAuto(deliveryId);
          if (!claim) continue;
          const attempt = this.options.processes.recordDeliveryAttempt(deliveryId);
          if (!attempt) continue;
          const result = await this.options.target.deliverBackgroundProcessExit({
            ...resolution.envelope,
            delivery: attempt
          });
          if (result.status === 'stale') this.options.processes.markDeliveryStale(deliveryId, result.reason);
          else this.options.processes.markDeliveryDelivered(deliveryId);
        } catch (error) {
          retryNeeded = true;
          try { this.options.processes.recordDeliveryFailure(deliveryId, error); }
          catch (recordError) { this.options.onError?.(recordError); }
          this.options.onError?.(error);
        }
      }
      if (retryNeeded && !this.disposed) this.scheduleScan(RETRY_DELAY_MS);
    }
  }

  private scheduleScan(delayMs: number): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scanRequested = true;
      this.launchScan();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
