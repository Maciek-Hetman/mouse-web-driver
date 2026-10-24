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
    return this.device.sendFeatureReport(reportId, data as Uint8Array<ArrayBuffer>);
  }

  /**
   * Raw feature report bytes. Whether Chrome prefixes the report id differs
   * between platforms and report ids, so drivers should check byte 0
   * against their own expected header rather than assume an offset.
   */
  async receiveFeature(reportId: number): Promise<Uint8Array> {
    const view = await this.device.receiveFeatureReport(reportId);
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  sendReport(reportId: number, data: Uint8Array): Promise<void> {
    return this.device.sendReport(reportId, data as Uint8Array<ArrayBuffer>);
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
