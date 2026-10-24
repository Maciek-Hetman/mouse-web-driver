import { describe, expect, it } from 'vitest';
import { DeviceAccessError, InterfaceMismatchError } from '../src/core/errors';
import { DriverRegistry } from '../src/core/registry';
import razerDriver from '../src/drivers/razer';
import { buildPacket, crc, decodeStageTable, encodeStageTable } from '../src/protocols/razer';
import { FakeHidDevice } from './fake-hid';
import { RazerSim, type RazerState } from './sim-razer';

const ctx = { platform: 'linux' as const };

function daV3(): RazerState {
  return {
    firmware: [1, 3],
    serial: 'PM2312H12345678',
    stages: [
      { x: 400, y: 400 },
      { x: 800, y: 800 },
      { x: 1600, y: 1600 },
    ],
    activeId: 2,
    dpi: { x: 800, y: 800 },
    extendedPolling: 0x08,
  };
}

describe('Razer packets', () => {
  it('builds a 90-byte packet with an XOR checksum over bytes 2..87', () => {
    const p = buildPacket(0x1f, 0x00, 0x81, 0x02);
    expect(p.length).toBe(90);
    expect([p[0], p[1], p[5], p[6], p[7]]).toEqual([0x00, 0x1f, 0x02, 0x00, 0x81]);
    expect(p[88]).toBe(0x02 ^ 0x00 ^ 0x81);
    expect(crc(p)).toBe(p[88]);
  });

  it('round-trips the DPI stage table', () => {
    const table = {
      activeId: 2,
      stages: [
        { id: 1, x: 400, y: 400, tail: [0, 0] as [number, number] },
        { id: 2, x: 26000, y: 13000, tail: [1, 2] as [number, number] },
      ],
    };
    expect(decodeStageTable(encodeStageTable(table))).toEqual(table);
  });
});

describe('Razer driver', () => {
  it('reads DeathAdder V3 settings', async () => {
    const sim = new RazerSim({ productId: 0x00b2, state: daV3() });
    const session = await razerDriver.open(sim.asHid(), ctx);
    expect(session.info).toMatchObject({ name: 'DeathAdder V3', firmware: 'v1.03', serial: 'PM2312H12345678' });
    expect(session.capabilities.pollingRate?.rates).toContain(8000);
    expect(session.capabilities.dpi?.max).toBe(30000);
    expect(await session.read()).toEqual({
      dpi: { stages: [{ x: 400 }, { x: 800 }, { x: 1600 }], active: 1 },
      pollingRate: 1000,
    });
  });

  it('writes DPI stages and the extended polling rate with its commit packet', async () => {
    const state = daV3();
    const sim = new RazerSim({ productId: 0x00b2, state });
    const session = await razerDriver.open(sim.asHid(), ctx);
    await session.read();
    sim.commands.length = 0;
    await session.write({ dpi: { stages: [{ x: 500 }, { x: 1200, y: 600 }], active: 1 }, pollingRate: 4000 });
    expect(state.stages).toEqual([
      { x: 500, y: 500 },
      { x: 1200, y: 600 },
    ]);
    expect(state.activeId).toBe(2);
    expect(state.dpi).toEqual({ x: 1200, y: 600 });
    const polling = sim.commands.filter((c) => c.cls === 0x00 && c.cmd === 0x40).map((c) => c.args);
    expect(polling).toEqual([
      [0x00, 0x02],
      [0x01, 0x02],
    ]);
    expect((await session.read()).pollingRate).toBe(4000);
  });

  it('falls back to the legacy polling command and offers the wireless extras', async () => {
    const state: RazerState = { ...daV3(), extendedPolling: undefined, legacyPolling: 0x02, idle: 300, battery: 128 };
    const sim = new RazerSim({ productId: 0x00c5, state, prefixReportId: true });
    const session = await razerDriver.open(sim.asHid(), ctx);
    expect(session.capabilities.pollingRate?.rates).toEqual([125, 500, 1000]);
    expect(session.capabilities.extras?.map((e) => e.id)).toEqual(['sleep']);
    const settings = await session.read();
    expect(settings.pollingRate).toBe(500);
    expect(settings.extras).toEqual({ sleep: '300' });
    expect(session.info.battery?.percent).toBe(50);
    await session.write({ extras: { sleep: '600' }, pollingRate: 125 });
    expect(state.idle).toBe(600);
    expect(state.legacyPolling).toBe(0x08);
  });

  it('only offers the Basilisk wheel settings the firmware answers', async () => {
    const state: RazerState = { ...daV3(), extendedPolling: undefined, legacyPolling: 1, wheel: { 0x14: 0, 0x17: 1 } };
    const session = await razerDriver.open(new RazerSim({ productId: 0x0099, state }).asHid(), ctx);
    expect(session.capabilities.extras?.map((e) => e.id)).toEqual(['freeSpin', 'smartReel']);
    expect((await session.read()).extras).toEqual({ freeSpin: false, smartReel: true });
    await session.write({ extras: { freeSpin: true } });
    expect(state.wheel![0x14]).toBe(1);
  });

  it('reports a silent interface as a mismatch so the next one is tried', async () => {
    const sim = new RazerSim({ productId: 0x00c5, state: daV3(), silent: true });
    await expect(razerDriver.open(sim.asHid(), ctx)).rejects.toBeInstanceOf(InterfaceMismatchError);
  });

  it('explains a blocked interface on Windows', async () => {
    class Blocked extends FakeHidDevice {
      override async sendFeatureReport(): Promise<void> {
        throw new DOMException('Failed to write the feature report.', 'NotAllowedError');
      }
    }
    const device = new Blocked({ vendorId: 0x1532, productId: 0x00b2 }).asHid();
    const err = await razerDriver.open(device, { platform: 'windows' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAccessError);
    expect((err as Error).message).toMatch(/Chrome on Windows/);
  });

  it('tries the Mouse collection before the other interfaces', () => {
    const keyboard = new FakeHidDevice({ vendorId: 0x1532, productId: 0x0099, collections: [{ usagePage: 0x01, usage: 0x06 }] }).asHid();
    const mouse = new FakeHidDevice({ vendorId: 0x1532, productId: 0x0099, collections: [{ usagePage: 0x01, usage: 0x02 }] }).asHid();
    const order = new DriverRegistry([razerDriver]).candidates([keyboard, mouse]).map((c) => c.device);
    expect(order).toEqual([mouse, keyboard]);
  });
});

describe('opening the device', () => {
  it('turns a refused open on Linux into udev advice', async () => {
    class Locked extends FakeHidDevice {
      override async open(): Promise<void> {
        throw new DOMException('Failed to open the device.', 'NotAllowedError');
      }
    }
    const device = new Locked({ vendorId: 0x1532, productId: 0x00b2 }).asHid();
    const err = await razerDriver.open(device, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceAccessError);
    expect((err as Error).message).toMatch(/Copy setup commands/);
  });
});
