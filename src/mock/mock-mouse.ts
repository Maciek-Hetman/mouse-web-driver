// An in-memory mouse that exercises every part of the UI without hardware.
// It lives outside src/drivers/ so the registry never offers it for a real device.

import { sleep } from '../core/transport';
import { cloneSettings, validateSettings } from '../core/settings';
import type { Capabilities, DeviceInfo, MouseSession, MouseSettings } from '../core/types';

export const mockCapabilities: Capabilities = {
  dpi: { min: 100, max: 26000, step: 50, maxStages: 5, perAxis: true },
  pollingRate: { rates: [125, 250, 500, 1000, 2000, 4000, 8000] },
  lod: {
    options: [
      { value: '1mm', label: '1 mm' },
      { value: '2mm', label: '2 mm' },
    ],
  },
  buttons: {
    buttons: [
      { id: 'left', label: 'Left button', remappable: false },
      { id: 'right', label: 'Right button' },
      { id: 'middle', label: 'Wheel click' },
      { id: 'back', label: 'Side back' },
      { id: 'forward', label: 'Side forward' },
      { id: 'dpi', label: 'DPI button' },
    ],
    actions: ['disabled', 'mouse', 'scroll', 'key', 'dpi', 'media'],
  },
  extras: [
    { type: 'toggle', id: 'motionSync', label: 'Motion sync', group: 'Sensor', description: 'Aligns sensor frames with USB polling.' },
    { type: 'toggle', id: 'angleSnapping', label: 'Angle snapping', group: 'Sensor' },
    { type: 'toggle', id: 'ripple', label: 'Ripple control', group: 'Sensor' },
    { type: 'range', id: 'debounce', label: 'Button debounce', group: 'Click behaviour', min: 0, max: 20, step: 1, unit: 'ms' },
    {
      type: 'select',
      id: 'sleep',
      label: 'Sleep after',
      group: 'Power',
      options: [
        { value: '30s', label: '30 seconds' },
        { value: '1m', label: '1 minute' },
        { value: '5m', label: '5 minutes' },
        { value: 'never', label: 'Never' },
      ],
    },
  ],
};

const initial: MouseSettings = {
  dpi: { stages: [{ x: 400 }, { x: 800 }, { x: 1600 }, { x: 3200 }], active: 1 },
  pollingRate: 1000,
  lod: '1mm',
  buttons: {
    left: { kind: 'default' },
    right: { kind: 'default' },
    middle: { kind: 'default' },
    back: { kind: 'default' },
    forward: { kind: 'default' },
    dpi: { kind: 'dpi', action: 'cycle-up' },
  },
  extras: { motionSync: true, angleSnapping: false, ripple: false, debounce: 4, sleep: '1m' },
};

// Module-level so a disconnect/reconnect in the same tab shows what was written.
let stored = cloneSettings(initial);

export function resetMockMouse(): void {
  stored = cloneSettings(initial);
}

export interface MockOptions {
  /** Simulated USB round-trip per read/write. */
  latencyMs?: number;
}

export function createMockSession(options: MockOptions = {}): MouseSession {
  const latency = options.latencyMs ?? 120;
  const info: DeviceInfo = {
    name: 'Demo Mouse',
    vendor: 'Mock',
    firmware: '1.0.0',
    connection: 'wireless',
    battery: { percent: 76, charging: false },
  };

  return {
    info,
    capabilities: mockCapabilities,
    notices: [{ level: 'info', message: 'This is a simulated mouse. Nothing is sent to real hardware.' }],

    async read() {
      await sleep(latency);
      return cloneSettings(stored);
    },

    async write(changes) {
      const errors = validateSettings(changes, mockCapabilities);
      if (errors.length > 0) throw new Error(errors.join(' '));
      await sleep(latency);
      stored = {
        ...stored,
        ...cloneSettings(changes),
        buttons: { ...stored.buttons, ...changes.buttons },
        extras: { ...stored.extras, ...changes.extras },
      };
    },

    async refreshInfo() {
      return info;
    },

    async close() {},
  };
}
