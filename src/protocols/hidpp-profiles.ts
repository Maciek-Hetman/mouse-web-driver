// HID++ 2.0 onboard profiles (feature 0x8100): what the mouse uses when no
// software is running. DPI stages, report rate and button mappings live here.
//
// Memory is split into sectors. Sector 0 (flash) lists the profiles as 4-byte
// entries [sector hi, sector lo, enabled, 0] ending in FF FF. A mouse that was
// never configured has an empty sector 0 and serves read-only factory profiles
// from ROM (header sector 0x0100). Every sector ends in a CRC-16/CCITT.
//
// Profile layout for formats 1-5 (as decoded by Solaar and libratbag):
//   0      report rate in ms
//   1      default DPI index      2  shift DPI index
//   3..12  5 x DPI, u16 little endian (0 or 0xFFFF = unused)
//   13..15 colour, 16 power mode, 17 angle snapping, 18..19 write counter
//   32..95 16 buttons x 4 bytes    96..159  16 G-shift buttons x 4 bytes
//   160..207 name, UTF-16LE        last 2   CRC, big endian
//
// We patch these bytes in place and leave everything else untouched.

import { maskToModifiers, modifiersToMask, keyCodeToUsage, usageToKeyCode } from '../core/hid-usage';
import type { ButtonAction, DpiButtonAction, MediaAction, MouseButton } from '../core/types';
import { Feature, type HidppDevice } from './hidpp';

const F = Feature.OnboardProfiles;

export interface ProfilesInfo {
  memoryModel: number;
  format: number;
  macroFormat: number;
  profileCount: number;
  oobProfileCount: number;
  buttonCount: number;
  sectorCount: number;
  sectorSize: number;
  mechanicalLayout: number;
}

export async function getProfilesInfo(d: HidppDevice): Promise<ProfilesInfo> {
  const r = await d.callFeature(F, 0x0);
  return {
    memoryModel: r[0]!,
    format: r[1]!,
    macroFormat: r[2]!,
    profileCount: r[3]!,
    oobProfileCount: r[4]!,
    buttonCount: r[5]!,
    sectorCount: r[6]!,
    sectorSize: (r[7]! << 8) | r[8]!,
    mechanicalLayout: r[9]!,
  };
}

/** Profile formats whose layout we know (see the header comment). */
export function isSupportedFormat(info: ProfilesInfo): boolean {
  return info.memoryModel === 1 && info.format >= 1 && info.format <= 5 && info.sectorSize >= 0xa0;
}

export const MODE_ONBOARD = 1;
export const MODE_HOST = 2;

export async function getMode(d: HidppDevice): Promise<number> {
  return (await d.callFeature(F, 0x2))[0]!;
}

export async function setMode(d: HidppDevice, mode: number): Promise<void> {
  await d.callFeature(F, 0x1, [mode]);
}

export async function getCurrentProfile(d: HidppDevice): Promise<number> {
  const r = await d.callFeature(F, 0x4);
  return (r[0]! << 8) | r[1]!;
}

export async function setCurrentProfile(d: HidppDevice, sector: number): Promise<void> {
  await d.callFeature(F, 0x3, [sector >> 8, sector & 0xff]);
}

export async function getCurrentDpiIndex(d: HidppDevice): Promise<number> {
  return (await d.callFeature(F, 0xb))[0]!;
}

export async function setCurrentDpiIndex(d: HidppDevice, index: number): Promise<void> {
  await d.callFeature(F, 0xc, [index]);
}

export async function readSector(d: HidppDevice, sector: number, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let o = 0;
  for (; o + 16 <= size; o += 16) {
    out.set(await d.callFeature(F, 0x5, [sector >> 8, sector & 0xff, o >> 8, o & 0xff]), o);
  }
  if (o < size) {
    // Reads can't run past the sector end, so fetch the last 16 bytes and keep the tail.
    const last = await d.callFeature(F, 0x5, [sector >> 8, sector & 0xff, (size - 16) >> 8, (size - 16) & 0xff]);
    out.set(last.subarray(16 - (size - o)), o);
  }
  return out;
}

export async function writeSector(d: HidppDevice, sector: number, bytes: Uint8Array): Promise<void> {
  await d.callFeature(F, 0x6, [sector >> 8, sector & 0xff, 0, 0, bytes.length >> 8, bytes.length & 0xff]);
  for (let o = 0; o < bytes.length; o += 16) await d.callFeature(F, 0x7, bytes.subarray(o, o + 16));
  await d.callFeature(F, 0x8);
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). */
export function crc16(bytes: ArrayLike<number>, length = bytes.length): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= bytes[i]! << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function crcOk(sector: Uint8Array): boolean {
  const n = sector.length;
  return crc16(sector, n - 2) === ((sector[n - 2]! << 8) | sector[n - 1]!);
}

export function sealSector(sector: Uint8Array): Uint8Array {
  const n = sector.length;
  const crc = crc16(sector, n - 2);
  sector[n - 2] = crc >> 8;
  sector[n - 1] = crc & 0xff;
  return sector;
}

export interface ProfileEntry {
  sector: number;
  enabled: boolean;
}

export interface ProfileDirectory {
  /** True when sector 0 is empty and the profiles come from read-only ROM. */
  rom: boolean;
  entries: ProfileEntry[];
}

export const ROM_DIRECTORY = 0x0100;

export function parseDirectory(bytes: Uint8Array): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  for (let o = 0; o + 4 <= bytes.length - 2; o += 4) {
    if (bytes[o] === 0xff && bytes[o + 1] === 0xff) break;
    entries.push({ sector: (bytes[o]! << 8) | bytes[o + 1]!, enabled: bytes[o + 2] !== 0 });
  }
  return entries;
}

export function buildDirectory(entries: ProfileEntry[], size: number): Uint8Array {
  const out = new Uint8Array(size).fill(0xff);
  entries.forEach((e, i) => out.set([e.sector >> 8, e.sector & 0xff, e.enabled ? 1 : 0, 0], i * 4));
  out.set([0xff, 0xff, 0, 0], entries.length * 4);
  return sealSector(out);
}

export async function readDirectory(d: HidppDevice, info: ProfilesInfo): Promise<ProfileDirectory> {
  const flash = await readSector(d, 0, info.sectorSize);
  const head = Array.from(flash.subarray(0, 4));
  if (head.every((b) => b === 0) || head.every((b) => b === 0xff)) {
    return { rom: true, entries: parseDirectory(await readSector(d, ROM_DIRECTORY, info.sectorSize)) };
  }
  return { rom: false, entries: parseDirectory(flash) };
}

// ---------------------------------------------------------------------------
// Profile fields
// ---------------------------------------------------------------------------

export const MAX_DPI_SLOTS = 5;
const DPI_OFFSET = 3;
const BUTTON_OFFSET = 32;

export function profileDpis(p: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < MAX_DPI_SLOTS; i++) {
    const v = p[DPI_OFFSET + i * 2]! | (p[DPI_OFFSET + i * 2 + 1]! << 8);
    if (v === 0 || v === 0xffff) break;
    out.push(v);
  }
  return out;
}

export function setProfileDpis(p: Uint8Array, dpis: number[], defaultIndex: number): void {
  // Keep whatever filler the firmware used for unused slots.
  const lastSlot = DPI_OFFSET + (MAX_DPI_SLOTS - 1) * 2;
  const filler = p[lastSlot] === 0xff && p[lastSlot + 1] === 0xff ? 0xffff : 0;
  for (let i = 0; i < MAX_DPI_SLOTS; i++) {
    const v = dpis[i] ?? filler;
    p[DPI_OFFSET + i * 2] = v & 0xff;
    p[DPI_OFFSET + i * 2 + 1] = v >> 8;
  }
  p[1] = defaultIndex;
  if (p[2]! >= dpis.length) p[2] = defaultIndex;
}

export function profileDefaultDpiIndex(p: Uint8Array): number {
  return p[1]!;
}

/** Report rate in Hz, if byte 0 holds a whole number of milliseconds. */
export function profileReportRate(p: Uint8Array): number | undefined {
  const ms = p[0]!;
  return ms >= 1 && ms <= 8 ? Math.round(1000 / ms) : undefined;
}

export function setProfileReportRate(p: Uint8Array, hz: number): void {
  const ms = 1000 / hz;
  if (!Number.isInteger(ms) || ms < 1 || ms > 8) throw new RangeError(`${hz} Hz can't be stored in an onboard profile`);
  p[0] = ms;
}

export function profileButton(p: Uint8Array, index: number): Uint8Array {
  return p.slice(BUTTON_OFFSET + index * 4, BUTTON_OFFSET + index * 4 + 4);
}

export function setProfileButton(p: Uint8Array, index: number, bytes: ArrayLike<number>): void {
  p.set(bytes, BUTTON_OFFSET + index * 4);
}

// ---------------------------------------------------------------------------
// Button encoding
// ---------------------------------------------------------------------------

const SEND = 0x80;
const FUNCTION = 0x90;
const enum Send {
  Nothing = 0x00,
  Button = 0x01,
  Key = 0x02,
  Consumer = 0x03,
}

const MOUSE_BITS: Record<MouseButton, number> = { left: 0x0001, right: 0x0002, middle: 0x0004, back: 0x0008, forward: 0x0010 };
const SCROLL_LEFT_BIT = 0x0040;
const SCROLL_RIGHT_BIT = 0x0080;

const DPI_FUNCTIONS: Record<DpiButtonAction, number> = { 'cycle-up': 0x03, 'cycle-down': 0x04, cycle: 0x05, shift: 0x07 };
const SCROLL_DOWN_FN = 0x10;
const SCROLL_UP_FN = 0x11;

export const MEDIA_USAGE: Record<MediaAction, number> = {
  'play-pause': 0xcd,
  next: 0xb5,
  previous: 0xb6,
  'volume-up': 0xe9,
  'volume-down': 0xea,
  mute: 0xe2,
};

/** The factory mapping of button `index` on a five-button mouse (left, right, middle, back, forward). */
export function factoryButton(index: number): Uint8Array | undefined {
  const bit = [0x0001, 0x0002, 0x0004, 0x0008, 0x0010][index];
  return bit === undefined ? undefined : new Uint8Array([SEND, Send.Button, bit >> 8, bit & 0xff]);
}

/** Decode a 4-byte button entry. Anything we can't represent (macros, profile switching…) reads as "default". */
export function decodeButton(b: Uint8Array, factory?: Uint8Array): ButtonAction {
  if (factory && b.every((v, i) => v === factory[i])) return { kind: 'default' };
  if (b[0] === SEND) {
    const v = (b[2]! << 8) | b[3]!;
    switch (b[1]) {
      case Send.Nothing:
        return { kind: 'disabled' };
      case Send.Button: {
        if (v === SCROLL_LEFT_BIT) return { kind: 'scroll', direction: 'left' };
        if (v === SCROLL_RIGHT_BIT) return { kind: 'scroll', direction: 'right' };
        const button = (Object.keys(MOUSE_BITS) as MouseButton[]).find((k) => MOUSE_BITS[k] === v);
        if (button) return { kind: 'mouse', button };
        break;
      }
      case Send.Key: {
        const code = usageToKeyCode(b[3]!);
        if (code) {
          const modifiers = maskToModifiers(b[2]!);
          return modifiers.length ? { kind: 'key', code, modifiers } : { kind: 'key', code };
        }
        break;
      }
      case Send.Consumer: {
        const action = (Object.keys(MEDIA_USAGE) as MediaAction[]).find((a) => MEDIA_USAGE[a] === v);
        if (action) return { kind: 'media', action };
        break;
      }
    }
  } else if (b[0] === FUNCTION) {
    if (b[1] === 0x00) return { kind: 'disabled' };
    if (b[1] === SCROLL_DOWN_FN) return { kind: 'scroll', direction: 'down' };
    if (b[1] === SCROLL_UP_FN) return { kind: 'scroll', direction: 'up' };
    const dpi = (Object.keys(DPI_FUNCTIONS) as DpiButtonAction[]).find((a) => DPI_FUNCTIONS[a] === b[1]);
    if (dpi) return { kind: 'dpi', action: dpi };
  }
  return { kind: 'default' };
}

/** Encode an action. `fallback` is used for "default" when the button has no known factory mapping. */
export function encodeButton(action: ButtonAction, factory: Uint8Array | undefined, fallback: Uint8Array): Uint8Array {
  switch (action.kind) {
    case 'default':
      return new Uint8Array(factory ?? fallback);
    case 'disabled':
      return new Uint8Array([SEND, Send.Nothing, 0xff, 0xff]);
    case 'mouse': {
      const bit = MOUSE_BITS[action.button];
      return new Uint8Array([SEND, Send.Button, bit >> 8, bit & 0xff]);
    }
    case 'scroll':
      if (action.direction === 'left' || action.direction === 'right') {
        const bit = action.direction === 'left' ? SCROLL_LEFT_BIT : SCROLL_RIGHT_BIT;
        return new Uint8Array([SEND, Send.Button, bit >> 8, bit & 0xff]);
      }
      return new Uint8Array([FUNCTION, action.direction === 'down' ? SCROLL_DOWN_FN : SCROLL_UP_FN, 0xff, 0x00]);
    case 'key': {
      const usage = keyCodeToUsage(action.code);
      if (usage === undefined) throw new RangeError(`Key ${action.code} can't be assigned to a Logitech button`);
      return new Uint8Array([SEND, Send.Key, modifiersToMask(action.modifiers), usage]);
    }
    case 'dpi':
      return new Uint8Array([FUNCTION, DPI_FUNCTIONS[action.action], 0xff, 0x00]);
    case 'media': {
      const usage = MEDIA_USAGE[action.action];
      return new Uint8Array([SEND, Send.Consumer, usage >> 8, usage & 0xff]);
    }
  }
}
