// A scriptable stand-in for HIDDevice so drivers and the transport can be
// tested without a browser or hardware.

export interface FakeHidOptions {
  vendorId: number;
  productId: number;
  productName?: string;
  collections?: Partial<HIDCollectionInfo>[];
  /** Called for every sendFeatureReport; the return value is what the next receiveFeatureReport reads. */
  onFeature?: (reportId: number, data: Uint8Array) => Uint8Array | void;
  /** Called for every sendReport; may return input reports to emit. */
  onOutput?: (reportId: number, data: Uint8Array) => { reportId: number; data: Uint8Array }[] | void;
}

export class FakeHidDevice extends EventTarget {
  opened = false;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HIDCollectionInfo[];
  readonly sentFeatures: { reportId: number; data: Uint8Array }[] = [];
  readonly sentReports: { reportId: number; data: Uint8Array }[] = [];
  private lastFeatureReply = new Uint8Array(0);
  oninputreport = null;

  constructor(private readonly options: FakeHidOptions) {
    super();
    this.vendorId = options.vendorId;
    this.productId = options.productId;
    this.productName = options.productName ?? 'Fake device';
    this.collections = (options.collections ?? [{ usagePage: 0x01, usage: 0x02 }]) as HIDCollectionInfo[];
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async forget() {}

  async sendFeatureReport(reportId: number, data: BufferSource) {
    const bytes = toBytes(data);
    this.sentFeatures.push({ reportId, data: bytes });
    const reply = this.options.onFeature?.(reportId, bytes);
    if (reply) this.lastFeatureReply = new Uint8Array(reply);
  }

  /** Returns the reply to the most recent sendFeatureReport, whatever the id. */
  async receiveFeatureReport(_reportId: number): Promise<DataView> {
    const last = this.lastFeatureReply;
    return new DataView(last.buffer, last.byteOffset, last.byteLength);
  }

  async sendReport(reportId: number, data: BufferSource) {
    const bytes = toBytes(data);
    this.sentReports.push({ reportId, data: bytes });
    const replies = this.options.onOutput?.(reportId, bytes) ?? [];
    for (const r of replies) queueMicrotask(() => this.emitInput(r.reportId, r.data));
  }

  emitInput(reportId: number, data: Uint8Array) {
    const event = new Event('inputreport') as Event & { reportId: number; data: DataView; device: unknown };
    event.reportId = reportId;
    event.data = new DataView(data.buffer, data.byteOffset, data.byteLength);
    event.device = this;
    this.dispatchEvent(event);
  }

  asHid(): HIDDevice {
    return this as unknown as HIDDevice;
  }
}

function toBytes(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  return new Uint8Array(data).slice();
}
