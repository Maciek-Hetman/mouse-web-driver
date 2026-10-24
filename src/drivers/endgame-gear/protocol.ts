// Endgame Gear 8K wired mice (OP1 8k v2, XM2 8k v2): config blob layout and
// the translation to and from the shared settings model.
//
// The mouse keeps its whole configuration in one 1041-byte feature report.
// Reading it is "send command 0x12 on report 0xA1, then GET_REPORT"; writing it
// is "SET_REPORT 0xA0 with byte 1 = 0x11 and the rest of the blob". There are no
// per-setting commands, so every write is read-modify-write of the whole blob.
//
// Offsets below count from the report id byte (byte 0); the payload starts at
// byte 16. Sources, both independent decodes of this protocol family:
//   - UnofficialEGGMouseConfig (niansa, public domain): wired 8K blob layout,
//     whole-blob store, firmware command.
//   - endgame-op1w re/PROTOCOL.md (Johannes Meyer zum Alten Borgloh, MIT):
//     button record framing, LED on lift-off, glass mode, status codes.
// Written from those descriptions; no code is copied.

import { keyCodeToUsage, maskToModifiers, modifiersToMask, usageToKeyCode } from '../../core/hid-usage';
import type {
  ButtonAction,
  ButtonInfo,
  Capabilities,
  Choice,
  DpiStage,
  ExtraValue,
  MediaAction,
  MouseButton,
  MouseSettings,
} from '../../core/types';

export const VENDOR_ID = 0x3367;
export const USAGE_PAGE = 0xff01;

export const REPORT_COMMAND = 0xa1; // 64 bytes including the id
export const REPORT_CONFIG = 0xa0; // 1041 bytes including the id
export const COMMAND_SIZE = 64;
export const CONFIG_SIZE = 1041;

export const CMD = {
  firmware: 0x02,
  store: 0x11,
  load: 0x12,
} as const;

export const STATUS = {
  ok: 0x01,
  busy: 0x03,
  rejected: 0x07,
} as const;
const KNOWN_STATUSES = new Set([0x01, 0x03, 0x07, 0x08, 0x11]);

export const OFFSET = {
  status: 1,
  pollingDivider: 21,
  filterFlags: 22,
  liftOffLed: 24,
  lod: 25,
  angleSnapping: 26,
  ripple: 27,
  motionSync: 28,
  activeStage: 29,
  stageCount: 30,
  /** 4 records of [xySplit, x u16le, y u16le]. */
  stages: 51,
  /** 8 records of [type, p1..p5, debounce]. */
  buttons: 71,
  glassMode: 127,
  forceMaxFps: 129,
} as const;

const STAGE_SIZE = 5;
const BUTTON_SIZE = 7;
const FILTER_SLAMCLICK = 0x01;
const SPDT_SAFE = 0xf0;
const SPDT_SPEED = 0xf1;

export interface ModelInfo {
  productId: number;
  name: string;
  /** False until someone has run this driver against the real mouse. */
  tested: boolean;
}

export const MODELS: ModelInfo[] = [
  { productId: 0x1978, name: 'OP1 8k v2', tested: true },
  { productId: 0x1980, name: 'XM2 8k v2', tested: false },
];

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Chrome returns feature reports with the report id prefixed on some platforms
 * and not on others, and some descriptors make the id byte read back as 0.
 * Return the bytes with byte 0 = report id and byte 1 = status either way.
 */
export function frameReport(raw: Uint8Array, reportId: number): Uint8Array {
  const hasHeader =
    raw.length >= 2 && (raw[0] === 0 || raw[0] === REPORT_COMMAND || raw[0] === REPORT_CONFIG) && KNOWN_STATUSES.has(raw[1]!);
  const out = new Uint8Array(hasHeader ? raw.length : raw.length + 1);
  out.set(raw, hasHeader ? 0 : 1);
  out[0] = reportId;
  return out;
}

/** The 63 data bytes of a report 0xA1 command (sendFeatureReport adds the id). */
export function commandPacket(cmd: number): Uint8Array {
  const data = new Uint8Array(COMMAND_SIZE - 1);
  data[0] = cmd;
  return data;
}

/** The 1040 data bytes that store `blob` (sendFeatureReport on 0xA0 adds the id). */
export function storePacket(blob: Uint8Array): Uint8Array {
  const data = new Uint8Array(CONFIG_SIZE - 1);
  data.set(blob.subarray(1, CONFIG_SIZE));
  data[0] = CMD.store;
  return data;
}

/** Firmware reply: minor at byte 17, major at byte 18, shown in hex like the vendor tool. */
export function parseFirmware(reply: Uint8Array): string | undefined {
  if (reply[OFFSET.status] !== STATUS.ok || reply.length < 19) return undefined;
  const major = reply[18]!;
  const minor = reply[17]!;
  if (major === 0 && minor === 0) return undefined;
  return `${major.toString(16)}.${minor.toString(16).padStart(2, '0')}`;
}

/** Whether a read-back looks like a real config blob rather than a short or stale reply. */
export function isValidBlob(blob: Uint8Array): boolean {
  if (blob.length <= OFFSET.forceMaxFps || blob[OFFSET.status] !== STATUS.ok) return false;
  const count = blob[OFFSET.stageCount]!;
  const firstX = u16(blob, OFFSET.stages + 1);
  return count >= 1 && count <= 4 && blob[OFFSET.pollingDivider]! >= 1 && firstX >= DPI.min && firstX <= DPI.max;
}

/** Pad a read-back to the full report size so offsets past the end read as zero. */
export function fullBlob(blob: Uint8Array): Uint8Array {
  const out = new Uint8Array(CONFIG_SIZE);
  out.set(blob.subarray(0, CONFIG_SIZE));
  return out;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const DPI = { min: 10, max: 30000 };
export const POLLING_RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

// Normal mode: index 0..10 = 0.7..1.7 mm. Glass mode: 0 = 1.0 mm, 1 = 2.0 mm.
const LOD_TENTHS = Array.from({ length: 11 }, (_, i) => ((7 + i) / 10).toFixed(1));
const LOD_GLASS = ['1.0', '2.0'];
const LOD_OPTIONS: Choice[] = [
  ...LOD_TENTHS.map((mm) => ({ value: mm, label: `${mm} mm` })),
  ...LOD_GLASS.map((mm) => ({
    value: `glass-${mm}`,
    label: `${mm} mm, glass mode`,
    description: 'Sensor glass mode, for glass mousepads. It has its own lift-off scale.',
  })),
];

interface ButtonSlot extends ButtonInfo {
  /** The factory binding, as [type, p1]. Parameters p2..p5 are zero. */
  factory: [number, number];
  /** Whether the slot has its own debounce byte worth exposing. */
  debounce?: boolean;
  spdt?: boolean;
}

// Record order from the endgame-op1w captures. Back/forward order is confirmed
// on the wireless 4K; still to be confirmed on the 8K.
const BUTTONS: ButtonSlot[] = [
  { id: 'left', label: 'Left button', remappable: false, factory: [0x00, 0x01], debounce: true, spdt: true },
  { id: 'right', label: 'Right button', factory: [0x00, 0x02], debounce: true, spdt: true },
  { id: 'middle', label: 'Wheel click', factory: [0x00, 0x04], debounce: true },
  { id: 'back', label: 'Side back', factory: [0x00, 0x08], debounce: true },
  { id: 'forward', label: 'Side forward', factory: [0x00, 0x10], debounce: true },
  { id: 'dpi', label: 'DPI button (underside)', factory: [0x09, 0xf1] },
  { id: 'wheelUp', label: 'Wheel up', factory: [0x01, 0x01] },
  { id: 'wheelDown', label: 'Wheel down', factory: [0x01, 0xff] },
];

const SWITCH_MODES: Choice[] = [
  { value: 'off', label: 'Off (use debounce)' },
  { value: 'safe', label: 'GX Safe' },
  { value: 'speed', label: 'GX Speed' },
];

export const capabilities: Capabilities = {
  dpi: { min: DPI.min, max: DPI.max, step: 10, maxStages: 4, perAxis: true },
  pollingRate: { rates: POLLING_RATES },
  lod: { options: LOD_OPTIONS },
  buttons: {
    buttons: BUTTONS.map(({ id, label, remappable }) => ({ id, label, remappable })),
    actions: ['disabled', 'mouse', 'scroll', 'key', 'dpi', 'media'],
  },
  extras: [
    { type: 'toggle', id: 'motionSync', label: 'Motion sync', group: 'Sensor', description: 'Aligns sensor frames with USB polling.' },
    { type: 'toggle', id: 'angleSnapping', label: 'Angle snapping', group: 'Sensor' },
    { type: 'toggle', id: 'ripple', label: 'Ripple control', group: 'Sensor' },
    {
      type: 'toggle',
      id: 'forceMaxFps',
      label: 'Force max sensor FPS',
      group: 'Sensor',
      description: 'Keeps the sensor at full frame rate instead of letting it slow down when idle.',
    },
    { type: 'toggle', id: 'liftOffLed', label: 'LED on lift-off', group: 'Sensor', description: 'Lights the LED when the mouse is lifted.' },
    {
      type: 'toggle',
      id: 'slamclick',
      label: 'Slam-click filter',
      group: 'Click behaviour',
      description: 'Ignores clicks caused by putting the mouse down hard.',
    },
    ...BUTTONS.filter((b) => b.spdt).map((b) => ({
      type: 'select' as const,
      id: `${b.id}SwitchMode`,
      label: `${b.label}: switch mode`,
      group: 'Click behaviour',
      description: 'Debounce is ignored while a GX mode is on.',
      options: SWITCH_MODES,
    })),
    ...BUTTONS.filter((b) => b.debounce).map((b) => ({
      type: 'range' as const,
      id: `${b.id}Debounce`,
      label: `${b.label}: debounce`,
      group: 'Click behaviour',
      min: 0,
      max: 25,
      step: 1,
    })),
  ],
};

// ---------------------------------------------------------------------------
// Blob -> settings
// ---------------------------------------------------------------------------

export interface Decoded {
  settings: MouseSettings;
  /** Labels of buttons whose binding the shared model can't express (shown as Default). */
  unknownButtons: string[];
  /** Set when the polling divider isn't one of the standard rates. */
  customPollingHz?: number;
}

export function decode(blob: Uint8Array): Decoded {
  const count = clamp(blob[OFFSET.stageCount]!, 1, 4);
  const stages: DpiStage[] = [];
  for (let i = 0; i < count; i++) {
    const at = OFFSET.stages + i * STAGE_SIZE;
    const x = u16(blob, at + 1);
    const y = u16(blob, at + 3);
    stages.push(blob[at] && y !== x ? { x, y } : { x });
  }
  const activeRaw = blob[OFFSET.activeStage]!;
  const active = activeRaw < count ? activeRaw : 0;

  const divider = blob[OFFSET.pollingDivider]! || 1;
  const exactHz = 8000 / divider;
  const pollingRate = POLLING_RATES.reduce((best, r) => (Math.abs(r - exactHz) < Math.abs(best - exactHz) ? r : best));

  const glass = blob[OFFSET.glassMode] !== 0;
  const lodByte = blob[OFFSET.lod]!;
  const lod = glass ? `glass-${LOD_GLASS[Math.min(lodByte, 1)]}` : LOD_TENTHS[Math.min(lodByte, LOD_TENTHS.length - 1)]!;

  const buttons: Record<string, ButtonAction> = {};
  const unknownButtons: string[] = [];
  const extras: Record<string, ExtraValue> = {
    motionSync: blob[OFFSET.motionSync] !== 0,
    angleSnapping: blob[OFFSET.angleSnapping] !== 0,
    ripple: blob[OFFSET.ripple] !== 0,
    forceMaxFps: blob[OFFSET.forceMaxFps] !== 0,
    liftOffLed: blob[OFFSET.liftOffLed] !== 0,
    slamclick: (blob[OFFSET.filterFlags]! & FILTER_SLAMCLICK) !== 0,
  };

  BUTTONS.forEach((slot, i) => {
    const at = OFFSET.buttons + i * BUTTON_SIZE;
    const record = blob.subarray(at, at + BUTTON_SIZE);
    const action = isFactory(record, slot) ? { kind: 'default' as const } : decodeAction(record);
    if (action) {
      buttons[slot.id] = action;
    } else {
      buttons[slot.id] = { kind: 'default' };
      unknownButtons.push(slot.label);
    }
    const filter = record[6]!;
    if (slot.spdt) extras[`${slot.id}SwitchMode`] = filter === SPDT_SAFE ? 'safe' : filter === SPDT_SPEED ? 'speed' : 'off';
    if (slot.debounce) extras[`${slot.id}Debounce`] = filter >= SPDT_SAFE ? 8 : Math.min(filter, 25);
  });

  return {
    settings: { dpi: { stages, active }, pollingRate, lod, buttons, extras },
    unknownButtons,
    customPollingHz: POLLING_RATES.includes(exactHz) ? undefined : Math.round(exactHz),
  };
}

const MOUSE_BITS: [MouseButton, number][] = [
  ['left', 0x01],
  ['right', 0x02],
  ['middle', 0x04],
  ['back', 0x08],
  ['forward', 0x10],
];

// Consumer page usages; all fit in the low byte.
const MEDIA_USAGES: [MediaAction, number][] = [
  ['play-pause', 0xcd],
  ['next', 0xb5],
  ['previous', 0xb6],
  ['mute', 0xe2],
  ['volume-up', 0xe9],
  ['volume-down', 0xea],
];

function isFactory(record: Uint8Array, slot: ButtonSlot): boolean {
  return record[0] === slot.factory[0] && record[1] === slot.factory[1] && record.subarray(2, 6).every((b) => b === 0);
}

function decodeAction(record: Uint8Array): ButtonAction | undefined {
  const [type, p1, p2] = [record[0]!, record[1]!, record[2]!];
  switch (type) {
    case 0x00: {
      const hit = MOUSE_BITS.find(([, bit]) => bit === p1);
      return hit && { kind: 'mouse', button: hit[0] };
    }
    case 0x01:
      return p1 === 0x01 ? { kind: 'scroll', direction: 'up' } : p1 === 0xff ? { kind: 'scroll', direction: 'down' } : undefined;
    case 0x02: {
      const code = usageToKeyCode(p2);
      if (!code) return undefined;
      const modifiers = maskToModifiers(p1);
      return modifiers.length ? { kind: 'key', code, modifiers } : { kind: 'key', code };
    }
    case 0x09:
      return p1 === 0xf1 ? { kind: 'dpi', action: 'cycle' } : undefined;
    case 0x20: {
      const hit = MEDIA_USAGES.find(([, usage]) => usage === p1);
      return hit && { kind: 'media', action: hit[0] };
    }
    case 0xff:
      return { kind: 'disabled' };
    default:
      // 0x0C (fixed CPI), browser/explorer launchers and anything newer.
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Settings -> blob
// ---------------------------------------------------------------------------

/** DPI the mouse can store: 10-step up to 10000, 50-step above. */
export function snapDpi(value: number): number {
  const v = clamp(Math.round(value), DPI.min, DPI.max);
  return v <= 10000 ? Math.round(v / 10) * 10 : Math.round(v / 50) * 50;
}

/** Return a copy of `blob` with `changes` applied. Throws on actions this mouse can't encode. */
export function applyChanges(blob: Uint8Array, changes: MouseSettings): Uint8Array {
  const out = fullBlob(blob);

  if (changes.dpi) {
    const { stages, active } = changes.dpi;
    out[OFFSET.stageCount] = stages.length;
    out[OFFSET.activeStage] = active;
    stages.forEach((stage, i) => {
      const at = OFFSET.stages + i * STAGE_SIZE;
      const x = snapDpi(stage.x);
      const y = snapDpi(stage.y ?? stage.x);
      out[at] = x !== y ? 1 : 0;
      setU16(out, at + 1, x);
      setU16(out, at + 3, y);
    });
  }

  if (changes.pollingRate !== undefined) {
    if (!POLLING_RATES.includes(changes.pollingRate)) throw new Error(`Unsupported polling rate ${changes.pollingRate} Hz.`);
    out[OFFSET.pollingDivider] = 8000 / changes.pollingRate;
  }

  if (changes.lod !== undefined) {
    const glassIndex = LOD_GLASS.findIndex((mm) => changes.lod === `glass-${mm}`);
    const tenthsIndex = LOD_TENTHS.indexOf(changes.lod);
    if (glassIndex >= 0) {
      out[OFFSET.glassMode] = 1;
      out[OFFSET.lod] = glassIndex;
    } else if (tenthsIndex >= 0) {
      out[OFFSET.glassMode] = 0;
      out[OFFSET.lod] = tenthsIndex;
    } else {
      throw new Error(`Unknown lift-off distance "${changes.lod}".`);
    }
  }

  for (const [id, action] of Object.entries(changes.buttons ?? {})) {
    const index = BUTTONS.findIndex((b) => b.id === id);
    if (index < 0) throw new Error(`Unknown button "${id}".`);
    const slot = BUTTONS[index]!;
    const at = OFFSET.buttons + index * BUTTON_SIZE;
    const encoded = action.kind === 'default' ? [...slot.factory, 0, 0, 0, 0] : encodeAction(action, slot.label);
    out.set(encoded, at); // 6 bytes: the debounce byte at +6 is left alone
  }

  const extras = changes.extras ?? {};
  const setBool = (id: string, offset: number) => {
    if (typeof extras[id] === 'boolean') out[offset] = extras[id] ? 1 : 0;
  };
  setBool('motionSync', OFFSET.motionSync);
  setBool('angleSnapping', OFFSET.angleSnapping);
  setBool('ripple', OFFSET.ripple);
  setBool('forceMaxFps', OFFSET.forceMaxFps);
  setBool('liftOffLed', OFFSET.liftOffLed);
  if (typeof extras.slamclick === 'boolean') {
    out[OFFSET.filterFlags] = extras.slamclick
      ? out[OFFSET.filterFlags]! | FILTER_SLAMCLICK
      : out[OFFSET.filterFlags]! & ~FILTER_SLAMCLICK;
  }

  // Switch mode and debounce share one byte per button. A GX mode wins; turning
  // it off restores the debounce value (the changed one, else the default 8).
  BUTTONS.forEach((slot, i) => {
    const at = OFFSET.buttons + i * BUTTON_SIZE + 6;
    const mode = extras[`${slot.id}SwitchMode`];
    const debounce = extras[`${slot.id}Debounce`];
    if (mode === 'safe') out[at] = SPDT_SAFE;
    else if (mode === 'speed') out[at] = SPDT_SPEED;
    else if (mode === 'off') out[at] = typeof debounce === 'number' ? debounce : 8;
    else if (typeof debounce === 'number' && out[at]! < SPDT_SAFE) out[at] = debounce;
  });

  return out;
}

function encodeAction(action: ButtonAction, label: string): number[] {
  const record = (type: number, p1 = 0, p2 = 0) => [type, p1, p2, 0, 0, 0];
  switch (action.kind) {
    case 'default':
    case 'disabled':
      return record(0xff);
    case 'mouse':
      return record(0x00, MOUSE_BITS.find(([b]) => b === action.button)![1]);
    case 'scroll':
      if (action.direction === 'up') return record(0x01, 0x01);
      if (action.direction === 'down') return record(0x01, 0xff);
      throw new Error(`${label}: this mouse can only bind scroll up or down.`);
    case 'key': {
      const usage = keyCodeToUsage(action.code);
      if (usage === undefined) throw new Error(`${label}: the key "${action.code}" can't be stored on this mouse.`);
      return record(0x02, modifiersToMask(action.modifiers), usage);
    }
    case 'dpi':
      if (action.action === 'cycle' || action.action === 'cycle-up') return record(0x09, 0xf1);
      throw new Error(`${label}: this mouse only supports DPI cycle.`);
    case 'media':
      return record(0x20, MEDIA_USAGES.find(([a]) => a === action.action)![1]);
  }
}

// ---------------------------------------------------------------------------

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function setU16(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = value >> 8;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
