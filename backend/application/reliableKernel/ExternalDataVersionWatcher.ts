export interface ExternalDataVersionWatcherOptions {
  pollIntervalMs?: number;
  autoSchedule?: boolean;
  onError?: (error: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Level-triggered watcher for commits made by another SQLite connection/Extension Host.
 *
 * The version is acknowledged only after refresh succeeds. A failed projection read is therefore
 * retried on the next poll instead of permanently accepting a version the consumer never painted.
 */
export class ExternalDataVersionWatcher {
  private readonly pollIntervalMs: number;
  private readonly autoSchedule: boolean;
  private readonly onError: (error: unknown) => void;
  private lastAppliedVersion: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pollInFlight: Promise<boolean> | undefined;
  private started = false;
  private stopped = false;

  public constructor(
    private readonly readVersion: () => Promise<string>,
    private readonly refresh: () => Promise<void>,
    options: ExternalDataVersionWatcherOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new RangeError('External data-version poll interval must be a positive integer.');
    }
    this.autoSchedule = options.autoSchedule !== false;
    this.onError = options.onError ?? (() => undefined);
  }

  /** Read the baseline before the consumer's initial snapshot, closing the startup handoff race. */
  public async start(): Promise<void> {
    if (this.started) return;
    if (this.stopped) throw new Error('External data-version watcher has been stopped.');
    this.lastAppliedVersion = requireVersion(await this.readVersion());
    this.started = true;
    this.schedule();
  }

  /** Public for deterministic tests and explicit level-triggered checks. */
  public pollNow(): Promise<boolean> {
    if (!this.started || this.stopped) return Promise.resolve(false);
    if (this.pollInFlight) return this.pollInFlight;
    const poll = this.runPoll()
      .finally(() => {
        if (this.pollInFlight === poll) this.pollInFlight = undefined;
      });
    this.pollInFlight = poll;
    return poll;
  }

  public async stop(): Promise<void> {
    this.cancel();
    await this.pollInFlight?.catch(() => undefined);
  }

  /** Stops admitting work without waiting for an already blocked external database read. */
  public cancel(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async runPoll(): Promise<boolean> {
    const observedVersion = requireVersion(await this.readVersion());
    if (this.stopped || observedVersion === this.lastAppliedVersion) return false;
    await this.refresh();
    if (this.stopped) return false;
    this.lastAppliedVersion = observedVersion;
    return true;
  }

  private schedule(): void {
    if (!this.autoSchedule || !this.started || this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pollNow()
        .catch((error) => this.onError(error))
        .finally(() => this.schedule());
    }, this.pollIntervalMs);
    this.timer.unref();
  }
}

function requireVersion(value: string): string {
  if (!/^\d+$/.test(value)) throw new TypeError('External SQLite data version must be decimal.');
  return value;
}
