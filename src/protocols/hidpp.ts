// Logitech HID++ 2.0 over WebHID.
//
// Every message goes out as a long report (id 0x11, 19 data bytes):
//   [device index, feature index, (function << 4) | software id, params…]
// Device index is 0xFF for a mouse on its own cable, 1-6 behind a receiver.
// Feature indexes differ per device and firmware, so they are looked up by
// feature id through the root feature (index 0) and cached.
//
// Errors come back as [index, 0xFF, feature index, function|swid, code]
// (HID++ 2.0) or, from a receiver, as a short report with sub id 0x8F.

import { HidTransport, TransportError } from '../core/transport';

export const SHORT_REPORT = 0x10;
export const LONG_REPORT = 0x11;
const LONG_PARAMS = 16;

export const Feature = {
  Root: 0x0000,
  FeatureSet: 0x0001,
  FirmwareInfo: 0x0003,
  DeviceName: 0x0005,
  BatteryStatus: 0x1000,
  UnifiedBattery: 0x1004,
  AdjustableDpi: 0x2201,
  ExtendedDpi: 0x2202,
  ReportRate: 0x8060,
  ExtendedReportRate: 0x8061,
  OnboardProfiles: 0x8100,
} as const;

const ERROR_NAMES: Record<number, string> = {
  0x01: 'unknown',
  0x02: 'invalid argument',
  0x03: 'out of range',
  0x04: 'hardware error',
  0x05: 'internal error',
  0x06: 'invalid feature index',
  0x07: 'invalid function',
  0x08: 'busy',
  0x09: 'unsupported',
};

export class HidppError extends Error {
  override name = 'HidppError';
  constructor(
    readonly code: number,
    readonly featureIndex: number,
    readonly fn: number,
  ) {
    super(`HID++ error on feature index ${featureIndex}, function ${fn}: ${ERROR_NAMES[code] ?? `code 0x${code.toString(16)}`}`);
  }
}

export interface CallOptions {
  timeoutMs?: number;
}

/** One HID++ 2.0 device (a mouse, either direct or behind a receiver). */
export class HidppDevice {
  private readonly features = new Map<number, number | null>();
  private swId = 0;

  constructor(
    readonly transport: HidTransport,
    readonly index: number,
  ) {}

  /** Call function `fn` of the feature at `featureIndex`. Returns the 16 parameter bytes of the reply. */
  call(featureIndex: number, fn: number, params: ArrayLike<number> = [], options: CallOptions = {}): Promise<Uint8Array> {
    // Rotate the software id (1-15) so a late reply to an earlier call can't be mistaken for this one.
    this.swId = (this.swId % 15) + 1;
    const fnSw = ((fn & 0x0f) << 4) | this.swId;
    const out = new Uint8Array(3 + LONG_PARAMS);
    out[0] = this.index;
    out[1] = featureIndex;
    out[2] = fnSw;
    out.set(Array.from(params).slice(0, LONG_PARAMS), 3);

    return this.transport.exclusive(async () => {
      const { reportId, data } = await this.transport.request(
        () => this.transport.sendReport(LONG_REPORT, out),
        (id, d) => {
          if (d.byteLength < 4 || d.getUint8(0) !== this.index) return false;
          if (id === LONG_REPORT && d.getUint8(1) === featureIndex && d.getUint8(2) === fnSw) return true;
          if (id === LONG_REPORT && d.getUint8(1) === 0xff && d.getUint8(2) === featureIndex && d.getUint8(3) === fnSw) return true;
          return id === SHORT_REPORT && d.getUint8(1) === 0x8f && d.getUint8(2) === featureIndex && d.getUint8(3) === fnSw;
        },
        options.timeoutMs,
      );
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (reportId === SHORT_REPORT || bytes[1] === 0xff) throw new HidppError(bytes[4]!, featureIndex, fn);
      const reply = new Uint8Array(LONG_PARAMS);
      reply.set(bytes.subarray(3, 3 + LONG_PARAMS));
      return reply;
    });
  }

  /** HID++ protocol version, or undefined if nothing answers at this index. */
  async ping(timeoutMs = 400): Promise<{ major: number; minor: number } | undefined> {
    try {
      const r = await this.call(0x00, 0x1, [0, 0, 0x5a], { timeoutMs });
      return { major: r[0]!, minor: r[1]! };
    } catch (err) {
      if (err instanceof TransportError || err instanceof HidppError) return undefined;
      throw err;
    }
  }

  /** Feature index for a feature id, or undefined if the device lacks it. Cached. */
  async featureIndex(featureId: number): Promise<number | undefined> {
    if (featureId === Feature.Root) return 0;
    if (!this.features.has(featureId)) {
      const r = await this.call(0x00, 0x0, [featureId >> 8, featureId & 0xff]);
      this.features.set(featureId, r[0] === 0 ? null : r[0]!);
    }
    return this.features.get(featureId) ?? undefined;
  }

  async has(featureId: number): Promise<boolean> {
    return (await this.featureIndex(featureId)) !== undefined;
  }

  /** Call a function on a feature by id. Throws if the device doesn't have it. */
  async callFeature(featureId: number, fn: number, params: ArrayLike<number> = [], options?: CallOptions): Promise<Uint8Array> {
    const index = await this.featureIndex(featureId);
    if (index === undefined) throw new Error(`Device lacks HID++ feature 0x${featureId.toString(16).padStart(4, '0')}`);
    return this.call(index, fn, params, options);
  }

  /** Every feature the device advertises, as [id, index, version] (for debug reports). */
  async listFeatures(): Promise<{ id: string; index: number; version: number }[]> {
    const setIndex = await this.featureIndex(Feature.FeatureSet);
    if (setIndex === undefined) return [];
    const count = (await this.call(setIndex, 0x0))[0]!;
    const out: { id: string; index: number; version: number }[] = [];
    for (let i = 1; i <= count; i++) {
      const r = await this.call(setIndex, 0x1, [i]);
      out.push({ id: ((r[0]! << 8) | r[1]!).toString(16).padStart(4, '0'), index: i, version: r[3]! });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Device info
// ---------------------------------------------------------------------------

export async function getDeviceName(d: HidppDevice): Promise<string | undefined> {
  if (!(await d.has(Feature.DeviceName))) return undefined;
  const length = (await d.callFeature(Feature.DeviceName, 0x0))[0]!;
  let name = '';
  while (name.length < length) {
    const chunk = await d.callFeature(Feature.DeviceName, 0x1, [name.length]);
    const text = String.fromCharCode(...chunk.filter((b) => b !== 0));
    if (!text) break;
    name += text;
  }
  return name.slice(0, length).trim();
}

const bcd = (b: number) => b.toString(16).padStart(2, '0');

/** Main application firmware, e.g. "RQM 69.01.B0010". */
export async function getFirmware(d: HidppDevice): Promise<string | undefined> {
  if (!(await d.has(Feature.FirmwareInfo))) return undefined;
  const count = (await d.callFeature(Feature.FirmwareInfo, 0x0))[0]!;
  for (let i = 0; i < count; i++) {
    const r = await d.callFeature(Feature.FirmwareInfo, 0x1, [i]);
    if ((r[0]! & 0x0f) !== 0) continue; // 0 = main application
    const prefix = String.fromCharCode(r[1]!, r[2]!, r[3]!).trim();
    return `${prefix} ${bcd(r[4]!)}.${bcd(r[5]!)}.B${bcd(r[6]!)}${bcd(r[7]!)}`;
  }
  return undefined;
}

export async function getBattery(d: HidppDevice): Promise<{ percent?: number; charging?: boolean } | undefined> {
  if (await d.has(Feature.UnifiedBattery)) {
    const r = await d.callFeature(Feature.UnifiedBattery, 0x1);
    return { percent: r[0]!, charging: r[2] === 1 || r[2] === 2 };
  }
  if (await d.has(Feature.BatteryStatus)) {
    const r = await d.callFeature(Feature.BatteryStatus, 0x0);
    return { percent: r[0]! || undefined, charging: r[2] === 1 || r[2] === 2 };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// DPI
// ---------------------------------------------------------------------------

/**
 * Decode a DPI list: big-endian u16 values ending in 0. A value with the top
 * three bits set (0xE000 | step) means "every `step` from the previous value
 * up to the next one".
 */
export function decodeDpiList(bytes: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const v = (bytes[i]! << 8) | bytes[i + 1]!;
    if (v === 0) break;
    if (v >> 13 === 0b111) {
      const step = v & 0x1fff;
      const last = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      const from = out[out.length - 1];
      if (from === undefined || !step || last <= from) break;
      for (let x = from + step; x <= last; x += step) out.push(x);
      i += 2;
    } else {
      out.push(v);
    }
  }
  return out;
}

export interface DpiInfo {
  feature: 0x2201 | 0x2202;
  values: number[];
  /** 0x2202 only: separate Y is supported. */
  perAxis: boolean;
  /** 0x2202 only: lift-off distance (low / medium / high) is supported. */
  lod: boolean;
}

async function readDpiList(d: HidppDevice, featureId: number, fn: number, headerBytes: number, direction = 0): Promise<number[]> {
  const bytes: number[] = [];
  // Long lists span several replies; ask for the next page until the 0 terminator shows up.
  for (let page = 0; page < 16; page++) {
    const r = await d.callFeature(featureId, fn, [0, direction, page]);
    bytes.push(...r.subarray(headerBytes));
    if (hasTerminator(bytes)) break;
  }
  return decodeDpiList(bytes);
}

function hasTerminator(bytes: number[]): boolean {
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const v = (bytes[i]! << 8) | bytes[i + 1]!;
    if (v === 0) return true;
    if (v >> 13 === 0b111) i += 2;
  }
  return false;
}

export async function getDpiInfo(d: HidppDevice): Promise<DpiInfo | undefined> {
  if (await d.has(Feature.ExtendedDpi)) {
    const caps = await d.callFeature(Feature.ExtendedDpi, 0x1, [0]);
    const values = await readDpiList(d, Feature.ExtendedDpi, 0x2, 3, 0);
    if (values.length) return { feature: Feature.ExtendedDpi, values, perAxis: (caps[2]! & 0x01) !== 0, lod: (caps[2]! & 0x02) !== 0 };
  }
  if (await d.has(Feature.AdjustableDpi)) {
    const values = await readDpiList(d, Feature.AdjustableDpi, 0x1, 1);
    if (values.length) return { feature: Feature.AdjustableDpi, values, perAxis: false, lod: false };
  }
  return undefined;
}

export interface SensorDpi {
  x: number;
  y: number;
  /** 0x2202 only: 0 low, 1 medium, 2 high. */
  lod?: number;
}

export async function getSensorDpi(d: HidppDevice, info: DpiInfo): Promise<SensorDpi> {
  const u16 = (r: Uint8Array, o: number) => (r[o]! << 8) | r[o + 1]!;
  if (info.feature === Feature.ExtendedDpi) {
    const r = await d.callFeature(Feature.ExtendedDpi, 0x5, [0]);
    // [sensor, x, default x, y, default y, lod]; 0 means "use the default".
    const x = u16(r, 1) || u16(r, 3);
    const y = u16(r, 5) || u16(r, 7) || x;
    return { x, y, lod: info.lod ? r[9] : undefined };
  }
  const r = await d.callFeature(Feature.AdjustableDpi, 0x2, [0]);
  const x = u16(r, 1) || u16(r, 3);
  return { x, y: x };
}

export async function setSensorDpi(d: HidppDevice, info: DpiInfo, dpi: SensorDpi): Promise<void> {
  if (info.feature === Feature.ExtendedDpi) {
    const y = info.perAxis ? dpi.y : 0;
    await d.callFeature(Feature.ExtendedDpi, 0x6, [0, dpi.x >> 8, dpi.x & 0xff, y >> 8, y & 0xff, info.lod ? (dpi.lod ?? 1) : 0]);
    return;
  }
  await d.callFeature(Feature.AdjustableDpi, 0x3, [0, dpi.x >> 8, dpi.x & 0xff]);
}

// ---------------------------------------------------------------------------
// Report rate
// ---------------------------------------------------------------------------

/** Index into this list is the 0x8061 rate code. */
const EXTENDED_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

export interface RateInfo {
  feature: 0x8060 | 0x8061;
  rates: number[];
}

export async function getRateInfo(d: HidppDevice): Promise<RateInfo | undefined> {
  if (await d.has(Feature.ExtendedReportRate)) {
    const r = await d.callFeature(Feature.ExtendedReportRate, 0x1);
    const flags = (r[0]! << 8) | r[1]!;
    const rates = EXTENDED_RATES.filter((_, i) => flags & (1 << i));
    if (rates.length) return { feature: Feature.ExtendedReportRate, rates };
  }
  if (await d.has(Feature.ReportRate)) {
    const flags = (await d.callFeature(Feature.ReportRate, 0x0))[0]!;
    const rates: number[] = [];
    // Bit n set means a report every n + 1 ms. Keep the ones that are whole Hz.
    for (let ms = 8; ms >= 1; ms--) if (flags & (1 << (ms - 1)) && 1000 % ms === 0) rates.push(1000 / ms);
    if (rates.length) return { feature: Feature.ReportRate, rates };
  }
  return undefined;
}

export async function getReportRate(d: HidppDevice, info: RateInfo): Promise<number | undefined> {
  if (info.feature === Feature.ExtendedReportRate) {
    return EXTENDED_RATES[(await d.callFeature(Feature.ExtendedReportRate, 0x2))[0]!];
  }
  const ms = (await d.callFeature(Feature.ReportRate, 0x1))[0]!;
  return ms ? Math.round(1000 / ms) : undefined;
}

export async function setReportRate(d: HidppDevice, info: RateInfo, hz: number): Promise<void> {
  if (info.feature === Feature.ExtendedReportRate) {
    const code = EXTENDED_RATES.indexOf(hz);
    if (code < 0) throw new RangeError(`${hz} Hz is not a HID++ rate`);
    await d.callFeature(Feature.ExtendedReportRate, 0x3, [code]);
    return;
  }
  await d.callFeature(Feature.ReportRate, 0x2, [Math.round(1000 / hz)]);
}
