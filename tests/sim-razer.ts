// A simulated Razer mouse that speaks the 90-byte feature-report protocol.

import { PACKET_LENGTH, Status, crc } from '../src/protocols/razer';
import { FakeHidDevice } from './fake-hid';

export interface RazerState {
  firmware: [number, number];
  serial: string;
  stages: { x: number; y: number }[];
  activeId: number;
  dpi: { x: number; y: number };
  /** Legacy polling code (divider of 1000), or undefined if the legacy command is unsupported. */
  legacyPolling?: number;
  /** Extended polling code (divider of 8000), or undefined if unsupported. */
  extendedPolling?: number;
  idle?: number;
  battery?: number;
  wheel?: Record<number, number>;
}

export interface RazerSimOptions {
  productId: number;
  collections?: Partial<HIDCollectionInfo>[];
  state: RazerState;
  /** Prefix replies with the report id, as some platforms do. */
  prefixReportId?: boolean;
  /** Never answer (wrong interface). */
  silent?: boolean;
}

export class RazerSim extends FakeHidDevice {
  readonly commands: { cls: number; cmd: number; args: number[] }[] = [];

  constructor(readonly opts: RazerSimOptions) {
    super({
      vendorId: 0x1532,
      productId: opts.productId,
      productName: 'Razer sim',
      collections: opts.collections ?? [{ usagePage: 0x01, usage: 0x02 }],
      onFeature: (_id, data) => (opts.silent ? new Uint8Array(PACKET_LENGTH) : this.handle(data)),
    });
  }

  private handle(req: Uint8Array): Uint8Array {
    const cls = req[6]!;
    const cmd = req[7]!;
    const args = Array.from(req.subarray(8, 88));
    this.commands.push({ cls, cmd, args: args.slice(0, req[5]) });
    const s = this.opts.state;
    const out: number[] = [];
    let status: number = Status.Ok;
    const key = (cls << 8) | cmd;
    switch (key) {
      case 0x0081:
        out.push(...s.firmware);
        break;
      case 0x0082:
        out.push(...Array.from(s.serial, (c) => c.charCodeAt(0)));
        break;
      case 0x0485:
        out.push(0x01, s.dpi.x >> 8, s.dpi.x & 0xff, s.dpi.y >> 8, s.dpi.y & 0xff);
        break;
      case 0x0405:
        s.dpi = { x: (args[1]! << 8) | args[2]!, y: (args[3]! << 8) | args[4]! };
        break;
      case 0x0486:
        out.push(0x01, s.activeId, s.stages.length);
        s.stages.forEach((st, i) => out.push(i + 1, st.x >> 8, st.x & 0xff, st.y >> 8, st.y & 0xff, 0, 0));
        break;
      case 0x0406: {
        s.activeId = args[1]!;
        s.stages = [];
        for (let i = 0; i < args[2]!; i++) {
          const o = 3 + i * 7;
          s.stages.push({ x: (args[o + 1]! << 8) | args[o + 2]!, y: (args[o + 3]! << 8) | args[o + 4]! });
        }
        break;
      }
      case 0x0085:
        if (s.legacyPolling === undefined) status = Status.Unsupported;
        else out.push(s.legacyPolling);
        break;
      case 0x0005:
        if (s.legacyPolling === undefined) status = Status.Unsupported;
        else s.legacyPolling = args[0]!;
        break;
      case 0x00c0:
        if (s.extendedPolling === undefined) status = Status.Unsupported;
        else out.push(0x00, s.extendedPolling);
        break;
      case 0x0040:
        if (s.extendedPolling === undefined) status = Status.Unsupported;
        else s.extendedPolling = args[1]!;
        break;
      case 0x0783:
        if (s.idle === undefined) status = Status.Unsupported;
        else out.push(s.idle >> 8, s.idle & 0xff);
        break;
      case 0x0703:
        s.idle = (args[0]! << 8) | args[1]!;
        break;
      case 0x0780:
        if (s.battery === undefined) status = Status.Unsupported;
        else out.push(0, s.battery);
        break;
      case 0x0784:
        if (s.battery === undefined) status = Status.Unsupported;
        else out.push(0, 0);
        break;
      default:
        if (cls === 0x02 && s.wheel) {
          const base = cmd & 0x7f;
          if (!(base in s.wheel)) status = Status.Unsupported;
          else if (cmd & 0x80) out.push(0x01, s.wheel[base]!);
          else s.wheel[base] = args[1]!;
        } else {
          status = Status.Unsupported;
        }
    }
    const reply = new Uint8Array(PACKET_LENGTH);
    reply.set(req.subarray(0, 8));
    reply[0] = status;
    reply.set(out, 8);
    reply[88] = crc(reply);
    if (!this.opts.prefixReportId) return reply;
    const prefixed = new Uint8Array(PACKET_LENGTH + 1);
    prefixed.set(reply, 1);
    return prefixed;
  }
}
