// Thin WebHID wrapper shared by drivers.
//
// Covers the three report styles our target protocols use:
//   - feature report set/get on report id 0 (Razer, 90-byte packets)
//   - feature report set on one id, get on another (Endgame Gear 0xA1 / 0xA0)
//   - output report + matching input report (Logitech HID++ 0x10/0x11)
// and serialises transactions so two UI actions never interleave packets.

export class TransportError extends Error {
  override name = 'TransportError';
}

export interface TransportOptions {
  /** Default timeout for request/response transactions. */
  timeoutMs?: number;
}

type InputListener = (event: HIDInputReportEvent) => void;

export interface TrafficEntry {
  /** Milliseconds since the page loaded. */
  t: number;
  device: string;
  dir: 'set-feature' | 'get-feature' | 'output' | 'input' | 'error';
  reportId: number;
  hex: string;
}

/**
 * The last few hundred packets every transport sent or received. The debug
 * report includes it, which is how we debug hardware we don't have.
 */
export class TrafficLog {
  private entries: TrafficEntry[] = [];

  constructor(readonly limit = 400) {}

  add(entry: Omit<TrafficEntry, 't'>): void {
    this.entries.push({ t: Math.round(performance.now()), ...entry });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  get all(): readonly TrafficEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}

export const traffic = new TrafficLog();

export function toHex(bytes: Uint8Array | DataView): string {
  const view = bytes instanceof DataView ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
  return Array.from(view, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export class HidTransport {
  readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly device: HIDDevice,
    options: TransportOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 1000;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  /**
   * Run `fn` after every previously queued transaction has finished. Use this
   * around any multi-packet exchange (send command, then read reply).
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Keep the chain alive even if this transaction fails.
    this.queue = run.catch(() => undefined);
    return run;
  }

  sendFeature(reportId: number, data: Uint8Array): Promise<void> {
    this.record('set-feature', reportId, data);
    return this.logErrors(reportId, this.device.sendFeatureReport(reportId, data as Uint8Array<ArrayBuffer>));
  }

  /**
   * Raw feature report bytes. Whether Chrome prefixes the report id differs
   * between platforms and report ids, so drivers should check byte 0
   * against their own expected header rather than assume an offset.
   */
  async receiveFeature(reportId: number): Promise<Uint8Array> {
    const view = await this.logErrors(reportId, this.device.receiveFeatureReport(reportId));
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    this.record('get-feature', reportId, bytes);
    return bytes;
  }

  sendReport(reportId: number, data: Uint8Array): Promise<void> {
    this.record('output', reportId, data);
    return this.logErrors(reportId, this.device.sendReport(reportId, data as Uint8Array<ArrayBuffer>));
  }

  private record(dir: TrafficEntry['dir'], reportId: number, data: Uint8Array | DataView): void {
    traffic.add({ device: this.device.productName, dir, reportId, hex: toHex(data) });
  }

  private async logErrors<T>(reportId: number, p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      traffic.add({ device: this.device.productName, dir: 'error', reportId, hex: message });
      throw err;
    }
  }

  /**
   * Install an input-report listener, run `send`, and resolve with the first
   * input report for which `match` returns true. Times out with TransportError.
   */
  request(
    send: () => Promise<void>,
    match: (reportId: number, data: DataView) => boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<{ reportId: number; data: DataView }> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const listener: InputListener = (event) => {
        this.record('input', event.reportId, event.data);
        if (!match(event.reportId, event.data)) return;
        cleanup();
        resolve({ reportId: event.reportId, data: event.data });
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.device.removeEventListener('inputreport', listener);
      };
      this.device.addEventListener('inputreport', listener);
      timer = setTimeout(() => {
        cleanup();
        reject(new TransportError(`No response within ${timeoutMs} ms`));
      }, timeoutMs);
      send().catch((err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new TransportError(String(err)));
      });
    });
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
