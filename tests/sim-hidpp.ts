// A simulated HID++ 2.0 mouse (Superlight-like) with onboard profiles in ROM.

import { crc16 } from '../src/protocols/hidpp-profiles';
import { FakeHidDevice } from './fake-hid';

type Replies = { reportId: number; data: Uint8Array }[];

export interface HidppSimOptions {
  productId?: number;
  /** Device index the mouse answers on (0xFF wired, 1-6 behind a receiver). */
  index?: number;
  features?: number[];
  profileFormat?: number;
}

const SECTOR_SIZE = 255;

export function makeProfile(dpis: number[], defaultIndex: number, reportMs = 1): Uint8Array {
  const p = new Uint8Array(SECTOR_SIZE).fill(0xff);
  p[0] = reportMs;
  p[1] = defaultIndex;
  p[2] = 0;
  for (let i = 0; i < 5; i++) {
    const v = dpis[i] ?? 0;
    p[3 + i * 2] = v & 0xff;
    p[4 + i * 2] = v >> 8;
  }
  p.fill(0, 13, 32);
  // Five factory buttons: left, right, middle, back, forward.
  [0x01, 0x02, 0x04, 0x08, 0x10].forEach((bit, i) => p.set([0x80, 0x01, 0x00, bit], 32 + i * 4));
  const crc = crc16(p, SECTOR_SIZE - 2);
  p[SECTOR_SIZE - 2] = crc >> 8;
  p[SECTOR_SIZE - 1] = crc & 0xff;
  return p;
}

export class HidppSim extends FakeHidDevice {
  readonly index: number;
  readonly featureIds: number[];
  readonly memory = new Map<number, Uint8Array>();
  dpi = 1600;
  rateIndex = 3;
  mode = 1;
  currentProfile = 0x0101;
  dpiIndex = 1;
  writes: number[] = [];
  private pendingWrite?: { sector: number; length: number; data: number[] };

  constructor(readonly opts: HidppSimOptions = {}) {
    super({
      vendorId: 0x046d,
      productId: opts.productId ?? 0xc09f,
      productName: 'Logitech sim',
      collections: [
        { usagePage: 0xff00, usage: 0x01 },
        { usagePage: 0xff00, usage: 0x02 },
      ],
      onOutput: (id, data) => this.handle(id, data),
    });
    this.index = opts.index ?? 0xff;
    this.featureIds = [0x0000, 0x0001, 0x0003, 0x0005, 0x1004, ...(opts.features ?? [0x2201, 0x8061, 0x8100])];

    const directory = new Uint8Array(SECTOR_SIZE).fill(0xff);
    directory.set([0x01, 0x01, 1, 0, 0x01, 0x02, 1, 0, 0xff, 0xff, 0, 0]);
    this.seal(directory);
    this.memory.set(0x0100, directory);
    this.memory.set(0x0101, makeProfile([800, 1600, 3200], 1));
    this.memory.set(0x0102, makeProfile([400, 800], 0));
    this.memory.set(0x0000, new Uint8Array(SECTOR_SIZE).fill(0xff));
  }

  private seal(p: Uint8Array) {
    const crc = crc16(p, p.length - 2);
    p[p.length - 2] = crc >> 8;
    p[p.length - 1] = crc & 0xff;
  }

  private handle(reportId: number, data: Uint8Array): Replies {
    if (reportId !== 0x11 || data[0] !== this.index) return [];
    const featureIndex = data[1]!;
    const fnSw = data[2]!;
    const fn = fnSw >> 4;
    const p = Array.from(data.subarray(3));
    const featureId = this.featureIds[featureIndex];
    const reply = (params: number[]): Replies => {
      const out = new Uint8Array(19);
      out.set([this.index, featureIndex, fnSw]);
      out.set(params.slice(0, 16), 3);
      return [{ reportId: 0x11, data: out }];
    };
    const error = (code: number): Replies => [{ reportId: 0x11, data: new Uint8Array([this.index, 0xff, featureIndex, fnSw, code, ...new Array(14).fill(0)]) }];
    if (featureId === undefined) return error(0x06);

    switch (featureId) {
      case 0x0000:
        if (fn === 0) {
          const idx = this.featureIds.indexOf((p[0]! << 8) | p[1]!);
          return reply([Math.max(0, idx), 0, 0]);
        }
        return reply([4, 2, p[2]!]);
      case 0x0001:
        if (fn === 0) return reply([this.featureIds.length - 1]);
        return reply([this.featureIds[p[0]!]! >> 8, this.featureIds[p[0]!]! & 0xff, 0, 0]);
      case 0x0003:
        if (fn === 0) return reply([1]);
        return reply([0, 0x52, 0x51, 0x4d, 0x69, 0x01, 0x00, 0x10]);
      case 0x0005: {
        const name = 'PRO X SUPERLIGHT 2c';
        if (fn === 0) return reply([name.length]);
        return reply(Array.from(name.slice(p[0]!, p[0]! + 16), (c) => c.charCodeAt(0)));
      }
      case 0x1004:
        return reply([77, 0x08, 0, 0]);
      case 0x2201:
        if (fn === 1) return reply([0, 0x00, 0x64, 0xe0, 0x32, 0xab, 0xe0, 0, 0]); // 100..44000 step 50
        if (fn === 2) return reply([0, this.dpi >> 8, this.dpi & 0xff, 0x03, 0x20]);
        if (fn === 3) {
          this.dpi = (p[1]! << 8) | p[2]!;
          return reply([]);
        }
        return error(0x07);
      case 0x8061:
        if (fn === 1) return reply([0x00, 0x7f]);
        if (fn === 2) return reply([this.rateIndex]);
        if (fn === 3) {
          this.rateIndex = p[0]!;
          return reply([]);
        }
        return error(0x07);
      case 0x8100:
        return this.profiles(fn, p, reply, error);
    }
    return error(0x07);
  }

  private profiles(fn: number, p: number[], reply: (b: number[]) => Replies, error: (c: number) => Replies): Replies {
    const sector = (p[0]! << 8) | p[1]!;
    switch (fn) {
      case 0x0:
        return reply([1, this.opts.profileFormat ?? 3, 1, 2, 0, 5, 16, SECTOR_SIZE >> 8, SECTOR_SIZE & 0xff, 1]);
      case 0x1:
        this.mode = p[0]!;
        return reply([]);
      case 0x2:
        return reply([this.mode]);
      case 0x3:
        this.currentProfile = sector;
        this.dpiIndex = this.memory.get(sector)![1]!;
        return reply([]);
      case 0x4:
        return reply([this.currentProfile >> 8, this.currentProfile & 0xff]);
      case 0x5: {
        const offset = (p[2]! << 8) | p[3]!;
        const mem = this.memory.get(sector) ?? new Uint8Array(SECTOR_SIZE);
        if (offset + 16 > SECTOR_SIZE) return error(0x02);
        return reply(Array.from(mem.subarray(offset, offset + 16)));
      }
      case 0x6:
        if (sector >= 16) return error(0x02);
        this.pendingWrite = { sector, length: (p[4]! << 8) | p[5]!, data: [] };
        return reply([]);
      case 0x7:
        this.pendingWrite!.data.push(...p);
        return reply([]);
      case 0x8: {
        const w = this.pendingWrite!;
        this.memory.set(w.sector, new Uint8Array(w.data.slice(0, w.length)));
        this.writes.push(w.sector);
        this.pendingWrite = undefined;
        return reply([]);
      }
      case 0xb:
        return reply([this.dpiIndex]);
      case 0xc:
        this.dpiIndex = p[0]!;
        return reply([]);
    }
    return error(0x07);
  }
}
