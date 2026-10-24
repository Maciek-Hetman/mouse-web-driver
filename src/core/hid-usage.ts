// HID usage tables shared by drivers that encode key bindings.
//
// Button remaps arrive as KeyboardEvent.code values (see ButtonAction) and most
// mice store them as HID Keyboard/Keypad page (0x07) usages plus a modifier
// bitmask, so the conversion lives here rather than in each driver.

import type { KeyModifier } from './types';

const KEYBOARD_USAGES: Record<string, number> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  PrintScreen: 0x46,
  ScrollLock: 0x47,
  Pause: 0x48,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  NumLock: 0x53,
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  NumpadDecimal: 0x63,
  IntlBackslash: 0x64,
  ContextMenu: 0x65,
  NumpadEqual: 0x67,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

// KeyA..KeyZ = 0x04..0x1D, Digit1..Digit9 = 0x1E..0x26, Digit0 = 0x27,
// F1..F12 = 0x3A..0x45, F13..F24 = 0x68..0x73, Numpad1..9 = 0x59..0x61, Numpad0 = 0x62.
for (let i = 0; i < 26; i++) KEYBOARD_USAGES[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
for (let i = 1; i <= 9; i++) KEYBOARD_USAGES[`Digit${i}`] = 0x1d + i;
KEYBOARD_USAGES.Digit0 = 0x27;
for (let i = 1; i <= 12; i++) KEYBOARD_USAGES[`F${i}`] = 0x39 + i;
for (let i = 13; i <= 24; i++) KEYBOARD_USAGES[`F${i}`] = 0x68 + (i - 13);
for (let i = 1; i <= 9; i++) KEYBOARD_USAGES[`Numpad${i}`] = 0x58 + i;
KEYBOARD_USAGES.Numpad0 = 0x62;

const CODES_BY_USAGE = new Map(Object.entries(KEYBOARD_USAGES).map(([code, usage]) => [usage, code]));

/** HID Keyboard page usage for a KeyboardEvent.code, or undefined if it has none. */
export function keyCodeToUsage(code: string): number | undefined {
  return KEYBOARD_USAGES[code];
}

/** KeyboardEvent.code for a HID Keyboard page usage, or undefined if we don't know it. */
export function usageToKeyCode(usage: number): string | undefined {
  return CODES_BY_USAGE.get(usage);
}

// Left-hand modifier bits of the standard boot keyboard modifier byte.
const MODIFIER_BITS: Record<KeyModifier, number> = { ctrl: 0x01, shift: 0x02, alt: 0x04, meta: 0x08 };

export function modifiersToMask(modifiers: readonly KeyModifier[] = []): number {
  return modifiers.reduce((mask, m) => mask | MODIFIER_BITS[m], 0);
}

/** Right-hand modifier bits (0x10..0x80) fold onto the same modifier. */
export function maskToModifiers(mask: number): KeyModifier[] {
  const folded = (mask | (mask >> 4)) & 0x0f;
  return (Object.keys(MODIFIER_BITS) as KeyModifier[]).filter((m) => folded & MODIFIER_BITS[m]);
}
