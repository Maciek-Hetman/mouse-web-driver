import { describe, expect, it } from 'vitest';
import { InterfaceMismatchError } from '../src/core/errors';
import logitechDriver from '../src/drivers/logitech';
import { decodeDpiList } from '../src/protocols/hidpp';
import { crc16, decodeButton, encodeButton, factoryButton } from '../src/protocols/hidpp-profiles';
import type { ButtonAction } from '../src/core/types';
import { HidppSim } from './sim-hidpp';

const ctx = { platform: 'linux' as const };

describe('HID++ helpers', () => {
  it('expands DPI ranges', () => {
    expect(decodeDpiList([0x00, 0x64, 0xe0, 0x32, 0x01, 0x2c, 0x03, 0xe8, 0, 0])).toEqual([100, 150, 200, 250, 300, 1000]);
  });

  it('uses CRC-16/CCITT-FALSE', () => {
    expect(crc16(Array.from('123456789', (c) => c.charCodeAt(0)))).toBe(0x29b1);
  });

  it('round-trips button actions', () => {
    const actions: ButtonAction[] = [
      { kind: 'disabled' },
      { kind: 'mouse', button: 'back' },
      { kind: 'scroll', direction: 'up' },
      { kind: 'scroll', direction: 'left' },
      { kind: 'key', code: 'KeyQ', modifiers: ['ctrl', 'shift'] },
      { kind: 'dpi', action: 'cycle-up' },
      { kind: 'media', action: 'mute' },
    ];
    for (const action of actions) {
      expect(decodeButton(encodeButton(action, undefined, new Uint8Array(4)))).toEqual(action);
    }
    expect(decodeButton(factoryButton(3)!, factoryButton(3))).toEqual({ kind: 'default' });
  });
});

describe('Logitech driver', () => {
  it('reads the active onboard profile', async () => {
    const sim = new HidppSim();
    const session = await logitechDriver.open(sim.asHid(), ctx);
    expect(session.info).toMatchObject({ name: 'PRO X SUPERLIGHT 2c', vendor: 'Logitech', firmware: 'RQM 69.01.B0010', connection: 'wired' });
    expect(session.capabilities.dpi).toMatchObject({ min: 100, max: 44000, step: 50, maxStages: 5 });
    expect(session.capabilities.pollingRate?.rates).toEqual([125, 250, 500, 1000]);
    const settings = await session.read();
    expect(settings.dpi).toEqual({ stages: [{ x: 800 }, { x: 1600 }, { x: 3200 }], active: 1 });
    expect(settings.pollingRate).toBe(1000);
    expect(settings.buttons).toMatchObject({ left: { kind: 'default' }, forward: { kind: 'default' } });
    expect(session.info.battery?.percent).toBe(77);
  });

  it('copies factory profiles to flash on the first save, then edits in place', async () => {
    const sim = new HidppSim();
    const session = await logitechDriver.open(sim.asHid(), ctx);
    await session.read();
    await session.write({ dpi: { stages: [{ x: 400 }, { x: 1250 }], active: 0 }, pollingRate: 500, buttons: { back: { kind: 'dpi', action: 'cycle' } } });

    // Two ROM profiles copied to sectors 1 and 2, directory written last, then the edit.
    expect(sim.writes).toEqual([1, 2, 0, 1]);
    expect(sim.currentProfile).toBe(1);
    expect(Array.from(sim.memory.get(0)!.subarray(0, 12))).toEqual([0, 1, 1, 0, 0, 2, 1, 0, 0xff, 0xff, 0, 0]);
    expect(Array.from(sim.memory.get(0x0101)!.subarray(3, 5))).toEqual([800 & 0xff, 800 >> 8]); // ROM untouched

    const settings = await session.read();
    expect(settings.dpi).toEqual({ stages: [{ x: 400 }, { x: 1250 }], active: 0 });
    expect(settings.pollingRate).toBe(500);
    expect(settings.buttons?.back).toEqual({ kind: 'dpi', action: 'cycle' });

    sim.writes = [];
    await session.write({ pollingRate: 1000 });
    expect(sim.writes).toEqual([1]);
  });

  it('switches a host-mode mouse back to onboard memory when saving', async () => {
    const sim = new HidppSim();
    sim.mode = 2;
    const session = await logitechDriver.open(sim.asHid(), ctx);
    expect(session.notices?.some((n) => /host mode/.test(n.message))).toBe(true);
    await session.read();
    await session.write({ pollingRate: 250 });
    expect(sim.mode).toBe(1);
  });

  it('falls back to live DPI and report rate when the profile format is unknown', async () => {
    const sim = new HidppSim({ profileFormat: 9 });
    const session = await logitechDriver.open(sim.asHid(), ctx);
    expect(session.capabilities.dpi?.maxStages).toBe(1);
    expect(session.capabilities.pollingRate?.rates).toEqual([125, 250, 500, 1000, 2000, 4000, 8000]);
    expect(session.capabilities.buttons).toBeUndefined();
    expect(await session.read()).toEqual({ dpi: { stages: [{ x: 1600 }], active: 0 }, pollingRate: 1000 });
    await session.write({ dpi: { stages: [{ x: 2000 }], active: 0 }, pollingRate: 8000 });
    expect(sim.dpi).toBe(2000);
    expect(sim.rateIndex).toBe(6);
    expect(sim.writes).toEqual([]);
  });

  it('finds the mouse behind a Lightspeed receiver', async () => {
    const sim = new HidppSim({ productId: 0xc54d, index: 1 });
    const session = await logitechDriver.open(sim.asHid(), ctx);
    expect(session.info.connection).toBe('receiver');
  });

  it('reports a receiver with no mouse behind it as a mismatch', async () => {
    const sim = new HidppSim({ productId: 0xc54d, index: 9 });
    await expect(logitechDriver.open(sim.asHid(), ctx)).rejects.toBeInstanceOf(InterfaceMismatchError);
  }, 10_000);
});
