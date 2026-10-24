// Translations between the UI's key model (KeyboardEvent.code and named
// modifiers) and the HID keyboard usages mouse firmware stores.

import type { KeyModifier } from './types';

const KEY_USAGES: Record<string, number> = {};

for (let i = 0; i < 26; i++) KEY_USAGES[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
for (let i = 1; i <= 9; i++) KEY_USAGES[`Digit${i}`] = 0x1e + i - 1;
KEY_USAGES.Digit0 = 0x27;
for (let i = 1; i <= 12; i++) KEY_USAGES[`F${i}`] = 0x3a + i - 1;
for (let i = 13; i <= 24; i++) KEY_USAGES[`F${i}`] = 0x68 + i - 13;
for (let i = 1; i <= 9; i++) KEY_USAGES[`Numpad${i}`] = 0x59 + i - 1;
KEY_USAGES.Numpad0 = 0x62;

Object.assign(KEY_USAGES, {
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
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
});

const USAGE_KEYS = new Map(Object.entries(KEY_USAGES).map(([code, usage]) => [usage, code]));

/** HID keyboard usage (page 0x07) for a KeyboardEvent.code, or undefined if we have no mapping. */
export function keyCodeToUsage(code: string): number | undefined {
  return KEY_USAGES[code];
}

export function usageToKeyCode(usage: number): string | undefined {
  return USAGE_KEYS.get(usage);
}

// Left-hand modifier bits of the standard keyboard report modifier byte.
const MODIFIER_BITS: Record<KeyModifier, number> = { ctrl: 0x01, shift: 0x02, alt: 0x04, meta: 0x08 };

export function modifiersToMask(modifiers: readonly KeyModifier[] = []): number {
  return modifiers.reduce((mask, m) => mask | MODIFIER_BITS[m], 0);
}

/** Accepts left (bits 0-3) and right (bits 4-7) modifier bits. */
export function maskToModifiers(mask: number): KeyModifier[] {
  const folded = (mask | (mask >> 4)) & 0x0f;
  return (Object.keys(MODIFIER_BITS) as KeyModifier[]).filter((m) => folded & MODIFIER_BITS[m]);
}
