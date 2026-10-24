// Razer's 90-byte feature-report protocol (the one OpenRazer and Synapse use).
//
//   0      status          0x00 new request, 0x01 busy, 0x02 ok, 0x03 fail,
//                          0x04 timeout (wireless mouse didn't answer the dongle),
//                          0x05 not supported
//   1      transaction id  per device family; a wrong one gets no answer at all
//   2..3   remaining packets (big endian), always 0 for us
//   4      protocol type, 0
//   5      data size       number of meaningful argument bytes
//   6      command class
//   7      command id      reads are the write id | 0x80
//   8..87  arguments
//   88     CRC             XOR of bytes 2..87
//   89     reserved
//
// Sent and read back with feature report id 0, which the descriptor never
// declares.

import { HidTransport, TransportError, sleep } from '../core/transport';

export const PACKET_LENGTH = 90;
const ARGS_OFFSET = 8;
const ARGS_LENGTH = 80;

export const Status = {
  New: 0x00,
  Busy: 0x01,
  Ok: 0x02,
  Fail: 0x03,
  Timeout: 0x04,
  Unsupported: 0x05,
} as const;

const STATUS_NAMES: Record<number, string> = {
  0x00: 'no reply',
  0x01: 'busy',
  0x03: 'command failed',
  0x04: 'mouse did not answer the receiver',
  0x05: 'command not supported',
};

export class RazerError extends Error {
  override name = 'RazerError';
  constructor(
    readonly status: number,
    readonly commandClass: number,
    readonly commandId: number,
  ) {
    super(`Razer command ${hex2(commandClass)}/${hex2(commandId)}: ${STATUS_NAMES[status] ?? `status ${hex2(status)}`}`);
  }
}

const hex2 = (n: number) => '0x' + n.toString(16).padStart(2, '0');

export function crc(packet: Uint8Array): number {
  let c = 0;
  for (let i = 2; i < 88; i++) c ^= packet[i]!;
  return c;
}

export function buildPacket(txn: number, commandClass: number, commandId: number, size: number, args: ArrayLike<number> = []): Uint8Array {
  if (args.length > ARGS_LENGTH) throw new RangeError('Razer arguments are at most 80 bytes');
  const p = new Uint8Array(PACKET_LENGTH);
  p[1] = txn;
  p[5] = size;
  p[6] = commandClass;
  p[7] = commandId;
  p.set(args, ARGS_OFFSET);
  p[88] = crc(p);
  return p;
}

export interface Reply {
  status: number;
  txn: number;
  size: number;
  commandClass: number;
  commandId: number;
  args: Uint8Array;
}

/**
 * Parse what receiveFeatureReport(0) returned. Some platforms prefix the
 * (undeclared) report id, giving 91 bytes; strip it.
 */
export function parseReply(raw: Uint8Array): Reply | undefined {
  let bytes = raw;
  if (bytes.length === PACKET_LENGTH + 1) bytes = bytes.subarray(1);
  if (bytes.length < PACKET_LENGTH) return undefined;
  return {
    status: bytes[0]!,
    txn: bytes[1]!,
    size: bytes[5]!,
    commandClass: bytes[6]!,
    commandId: bytes[7]!,
    args: bytes.slice(ARGS_OFFSET, ARGS_OFFSET + ARGS_LENGTH),
  };
}

export interface ConnectionOptions {
  /** Transaction id; 0x1F for every current mouse we support. */
  txn?: number;
  /** Wait before the first read. Wireless dongles need longer to relay. */
  replyDelayMs?: number;
  /** Give up after this long if the device keeps saying busy or never answers. */
  replyTimeoutMs?: number;
}

/** One Razer control interface. Every call is serialised through the transport. */
export class RazerConnection {
  readonly txn: number;
  readonly replyDelayMs: number;
  readonly replyTimeoutMs: number;

  constructor(
    readonly transport: HidTransport,
    options: ConnectionOptions = {},
  ) {
    this.txn = options.txn ?? 0x1f;
    this.replyDelayMs = options.replyDelayMs ?? 5;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 600;
  }

  /**
   * Send a command and return its argument bytes. Throws RazerError when the
   * device answers with a failure status, TransportError when it never
   * answers this command.
   */
  command(commandClass: number, commandId: number, size: number, args: ArrayLike<number> = []): Promise<Uint8Array> {
    const packet = buildPacket(this.txn, commandClass, commandId, size, args);
    return this.transport.exclusive(async () => {
      await this.transport.sendFeature(0, packet);
      const deadline = Date.now() + this.replyTimeoutMs;
      let wait = this.replyDelayMs;
      for (;;) {
        await sleep(wait);
        const reply = parseReply(await this.transport.receiveFeature(0));
        const ours = reply && reply.commandClass === commandClass && reply.commandId === commandId && reply.txn === this.txn;
        if (ours && reply.status === Status.Ok) return reply.args;
        // Busy, or a stale buffer from before our command landed: poll again.
        const pending = !ours || reply.status === Status.Busy || reply.status === Status.New;
        if (!pending) throw new RazerError(reply.status, commandClass, commandId);
        if (Date.now() >= deadline) {
          if (ours) throw new RazerError(reply.status, commandClass, commandId);
          throw new TransportError(`No reply to Razer command ${hex2(commandClass)}/${hex2(commandId)}`);
        }
        wait = Math.min(wait * 2, 50);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Store in flash (survives replug) rather than RAM only. */
const VARSTORE = 0x01;

export async function getFirmware(c: RazerConnection): Promise<string> {
  const a = await c.command(0x00, 0x81, 0x02);
  return `v${a[0]}.${a[1]!.toString().padStart(2, '0')}`;
}

export async function getSerial(c: RazerConnection): Promise<string> {
  const a = await c.command(0x00, 0x82, 0x16);
  return String.fromCharCode(...a.subarray(0, 0x16).filter((b) => b >= 0x20 && b < 0x7f)).trim();
}

/** One stored DPI stage as the device returns it. `tail` is kept so writes mirror the read exactly. */
export interface RawStage {
  id: number;
  x: number;
  y: number;
  tail: [number, number];
}

export interface StageTable {
  /** Stage id (not index) of the active stage. */
  activeId: number;
  stages: RawStage[];
}

const STAGE_TABLE_SIZE = 0x26;
const MAX_STAGES = 5;

export async function getDpiStages(c: RazerConnection): Promise<StageTable> {
  const a = await c.command(0x04, 0x86, STAGE_TABLE_SIZE, [VARSTORE]);
  return decodeStageTable(a);
}

export function decodeStageTable(a: Uint8Array): StageTable {
  const count = Math.min(a[2]!, MAX_STAGES);
  const stages: RawStage[] = [];
  for (let i = 0; i < count; i++) {
    const o = 3 + i * 7;
    stages.push({ id: a[o]!, x: (a[o + 1]! << 8) | a[o + 2]!, y: (a[o + 3]! << 8) | a[o + 4]!, tail: [a[o + 5]!, a[o + 6]!] });
  }
  return { activeId: a[1]!, stages };
}

export function encodeStageTable(table: StageTable): Uint8Array {
  const a = new Uint8Array(STAGE_TABLE_SIZE);
  a[0] = VARSTORE;
  a[1] = table.activeId;
  a[2] = table.stages.length;
  table.stages.forEach((s, i) => {
    const o = 3 + i * 7;
    a.set([s.id, s.x >> 8, s.x & 0xff, s.y >> 8, s.y & 0xff, s.tail[0], s.tail[1]], o);
  });
  return a;
}

export async function setDpiStages(c: RazerConnection, table: StageTable): Promise<void> {
  await c.command(0x04, 0x06, STAGE_TABLE_SIZE, encodeStageTable(table));
}

export async function getDpi(c: RazerConnection): Promise<{ x: number; y: number }> {
  const a = await c.command(0x04, 0x85, 0x07, [VARSTORE]);
  return { x: (a[1]! << 8) | a[2]!, y: (a[3]! << 8) | a[4]! };
}

export async function setDpi(c: RazerConnection, x: number, y: number): Promise<void> {
  await c.command(0x04, 0x05, 0x07, [VARSTORE, x >> 8, x & 0xff, y >> 8, y & 0xff, 0, 0]);
}

// Polling rate. The legacy command stores a divider of 1000 Hz, the extended
// (HyperPolling) one a divider of 8000 Hz.
const LEGACY_RATES: Record<number, number> = { 1000: 0x01, 500: 0x02, 125: 0x08 };
const EXTENDED_RATES: Record<number, number> = { 8000: 0x01, 4000: 0x02, 2000: 0x04, 1000: 0x08, 500: 0x10, 250: 0x20, 125: 0x40 };

export type PollingCommand = 'legacy' | 'extended';

export function pollingRates(kind: PollingCommand): number[] {
  return Object.keys(kind === 'legacy' ? LEGACY_RATES : EXTENDED_RATES)
    .map(Number)
    .sort((a, b) => a - b);
}

function rateFromCode(kind: PollingCommand, code: number): number | undefined {
  const table = kind === 'legacy' ? LEGACY_RATES : EXTENDED_RATES;
  const hit = Object.entries(table).find(([, c]) => c === code);
  return hit ? Number(hit[0]) : undefined;
}

export async function getPollingRate(c: RazerConnection, kind: PollingCommand): Promise<number | undefined> {
  if (kind === 'legacy') {
    const a = await c.command(0x00, 0x85, 0x01);
    return rateFromCode(kind, a[0]!);
  }
  const a = await c.command(0x00, 0xc0, 0x01, [0x00]);
  // The reply echoes the selector byte first on the captures we know of.
  return rateFromCode(kind, a[1]!) ?? rateFromCode(kind, a[0]!);
}

export async function setPollingRate(c: RazerConnection, kind: PollingCommand, hz: number): Promise<void> {
  if (kind === 'legacy') {
    const code = LEGACY_RATES[hz];
    if (code === undefined) throw new RangeError(`${hz} Hz is not a legacy Razer rate`);
    await c.command(0x00, 0x05, 0x01, [code]);
    return;
  }
  const code = EXTENDED_RATES[hz];
  if (code === undefined) throw new RangeError(`${hz} Hz is not an extended Razer rate`);
  await c.command(0x00, 0x40, 0x02, [0x00, code]);
  // Synapse follows up with the same rate on selector 0x01, which commits it.
  await c.command(0x00, 0x40, 0x02, [0x01, code]);
}

// Power (wireless models).

export async function getBattery(c: RazerConnection): Promise<number> {
  const a = await c.command(0x07, 0x80, 0x02);
  return Math.round((a[1]! / 255) * 100);
}

export async function getCharging(c: RazerConnection): Promise<boolean> {
  const a = await c.command(0x07, 0x84, 0x02);
  return a[1] === 1;
}

/** Seconds of inactivity before the mouse sleeps. */
export async function getIdleTime(c: RazerConnection): Promise<number> {
  const a = await c.command(0x07, 0x83, 0x02);
  return (a[0]! << 8) | a[1]!;
}

export async function setIdleTime(c: RazerConnection, seconds: number): Promise<void> {
  await c.command(0x07, 0x03, 0x02, [seconds >> 8, seconds & 0xff]);
}

// Scroll wheel (Basilisk V3).

export type WheelSetting = 'freeSpin' | 'acceleration' | 'smartReel';
const WHEEL_COMMANDS: Record<WheelSetting, number> = { freeSpin: 0x14, acceleration: 0x16, smartReel: 0x17 };

export async function getWheel(c: RazerConnection, setting: WheelSetting): Promise<boolean> {
  const a = await c.command(0x02, WHEEL_COMMANDS[setting] | 0x80, 0x02, [VARSTORE]);
  return a[1] === 1;
}

export async function setWheel(c: RazerConnection, setting: WheelSetting, on: boolean): Promise<void> {
  await c.command(0x02, WHEEL_COMMANDS[setting], 0x02, [VARSTORE, on ? 1 : 0]);
}
