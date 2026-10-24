import { describe, expect, it } from 'vitest';
import { DriverRegistry } from '../src/core/registry';
import { validateSettings } from '../src/core/settings';
import driver from '../src/drivers/endgame-gear';
import { CONFIG_SIZE, OFFSET, capabilities, decode, frameReport, snapDpi } from '../src/drivers/endgame-gear/protocol';
import { FakeHidDevice } from './fake-hid';

const ctx = { platform: 'linux' as const };

/** A factory-fresh OP1 8k v2 blob as the mouse returns it: byte 0 report id, byte 1 status. */
function factoryBlob(): Uint8Array {
  const b = new Uint8Array(CONFIG_SIZE);
  b[0] = 0xa1;
  b[1] = 0x01;
  b[OFFSET.pollingDivider] = 1;
  b[OFFSET.filterFlags] = 0x01;
  b[OFFSET.liftOffLed] = 1;
  b[OFFSET.lod] = 3; // 1.0 mm
  b[OFFSET.activeStage] = 1;
  b[OFFSET.stageCount] = 4;
  [400, 800, 1600, 3200].forEach((dpi, i) => {
    const at = OFFSET.stages + i * 5;
    b[at + 1] = dpi & 0xff;
    b[at + 2] = dpi >> 8;
    b[at + 3] = dpi & 0xff;
    b[at + 4] = dpi >> 8;
  });
  const records = [
    [0x00, 0x01],
    [0x00, 0x02],
    [0x00, 0x04],
    [0x00, 0x08],
    [0x00, 0x10],
    [0x09, 0xf1],
    [0x01, 0x01],
    [0x01, 0xff],
  ];
  records.forEach(([type, p1], i) => {
    const at = OFFSET.buttons + i * 7;
    b[at] = type!;
    b[at + 1] = p1!;
    b[at + 6] = 8;
  });
  return b;
}

interface FakeEggOptions {
  /** Strip the report id from replies, as Chrome does on some platforms. */
  stripId?: boolean;
  storeStatus?: number;
}

function fakeEgg(blob = factoryBlob(), options: FakeEggOptions = {}) {
  const reply = (bytes: Uint8Array) => (options.stripId ? bytes.slice(1) : bytes);
  const status = (code: number) => {
    const r = new Uint8Array(64);
    r[0] = 0xa1;
    r[1] = code;
    return reply(r);
  };
  const fake = new FakeHidDevice({
    vendorId: 0x3367,
    productId: 0x1978,
    productName: 'Endgame Gear OP1 8k v2',
    collections: [{ usagePage: 0xff01, usage: 0x02 }],
    onFeature: (id, data) => {
      if (id === 0xa1 && data[0] === 0x12) return reply(blob.slice());
      if (id === 0xa1 && data[0] === 0x02) {
        const r = status(0x01);
        r[options.stripId ? 16 : 17] = 0x07; // minor
        r[options.stripId ? 17 : 18] = 0x01; // major
        return r;
      }
      if (id === 0xa0 && data[0] === 0x11) {
        const code = options.storeStatus ?? 0x01;
        if (code === 0x01) blob.set(data.subarray(1), 2);
        return status(code);
      }
      return status(0x07);
    },
  });
  return { fake, blob };
}

describe('Endgame Gear driver', () => {
  it('claims only the vendor interface', () => {
    const registry = new DriverRegistry([driver]);
    const mouseIf = new FakeHidDevice({ vendorId: 0x3367, productId: 0x1978, collections: [{ usagePage: 0x01, usage: 0x02 }] }).asHid();
    const { fake } = fakeEgg();
    expect(registry.pick([mouseIf, fake.asHid()])?.device).toBe(fake.asHid());
  });

  it('reads the factory configuration', async () => {
    const { fake } = fakeEgg();
    const session = await driver.open(fake.asHid(), ctx);
    expect(session.info).toMatchObject({ name: 'OP1 8k v2', vendor: 'Endgame Gear', firmware: '1.07' });
    expect(session.notices).toEqual([]);
    const s = await session.read();
    expect(s.dpi).toEqual({ stages: [{ x: 400 }, { x: 800 }, { x: 1600 }, { x: 3200 }], active: 1 });
    expect(s.pollingRate).toBe(8000);
    expect(s.lod).toBe('1.0');
    expect(Object.values(s.buttons!).every((a) => a.kind === 'default')).toBe(true);
    expect(s.extras).toMatchObject({ slamclick: true, liftOffLed: true, motionSync: false, leftSwitchMode: 'off', leftDebounce: 8 });
    expect(validateSettings(s, session.capabilities)).toEqual([]);
  });

  it('handles replies without the report id prefix', async () => {
    const { fake } = fakeEgg(factoryBlob(), { stripId: true });
    const session = await driver.open(fake.asHid(), ctx);
    expect(session.info.firmware).toBe('1.07');
    expect((await session.read()).dpi?.stages[2]).toEqual({ x: 1600 });
  });

  it('writes DPI and polling rate and reads them back', async () => {
    const { fake, blob } = fakeEgg();
    const session = await driver.open(fake.asHid(), ctx);
    await session.write({ dpi: { stages: [{ x: 1200 }, { x: 25000, y: 20000 }], active: 1 }, pollingRate: 1000 });

    expect(blob[OFFSET.stageCount]).toBe(2);
    expect(blob[OFFSET.activeStage]).toBe(1);
    expect(blob[OFFSET.pollingDivider]).toBe(8);
    expect(blob[OFFSET.stages + 5]).toBe(1); // xySplit on stage 2
    const s = await session.read();
    expect(s.dpi).toEqual({ stages: [{ x: 1200 }, { x: 25000, y: 20000 }], active: 1 });
    expect(s.pollingRate).toBe(1000);

    const store = fake.sentFeatures.find((f) => f.reportId === 0xa0)!;
    expect(store.data.length).toBe(CONFIG_SIZE - 1);
    expect(store.data[0]).toBe(0x11);
  });

  it('skips the store when nothing changes', async () => {
    const { fake } = fakeEgg();
    const session = await driver.open(fake.asHid(), ctx);
    await session.write({ pollingRate: 8000 });
    expect(fake.sentFeatures.some((f) => f.reportId === 0xa0)).toBe(false);
  });

  it('switches lift-off scale with glass mode', async () => {
    const { fake, blob } = fakeEgg();
    const session = await driver.open(fake.asHid(), ctx);
    await session.write({ lod: 'glass-2.0' });
    expect([blob[OFFSET.glassMode], blob[OFFSET.lod]]).toEqual([1, 1]);
    expect((await session.read()).lod).toBe('glass-2.0');
    await session.write({ lod: '0.7' });
    expect([blob[OFFSET.glassMode], blob[OFFSET.lod]]).toEqual([0, 0]);
  });

  it('remaps buttons without touching their debounce byte', async () => {
    const { fake, blob } = fakeEgg();
    const session = await driver.open(fake.asHid(), ctx);
    await session.write({
      buttons: {
        back: { kind: 'key', code: 'KeyA', modifiers: ['shift'] },
        forward: { kind: 'media', action: 'volume-down' },
        dpi: { kind: 'disabled' },
        wheelDown: { kind: 'mouse', button: 'middle' },
      },
    });
    const back = OFFSET.buttons + 3 * 7;
    expect([...blob.subarray(back, back + 7)]).toEqual([0x02, 0x02, 0x04, 0, 0, 0, 8]);
    const s = await session.read();
    expect(s.buttons).toMatchObject({
      back: { kind: 'key', code: 'KeyA', modifiers: ['shift'] },
      forward: { kind: 'media', action: 'volume-down' },
      dpi: { kind: 'disabled' },
      wheelDown: { kind: 'mouse', button: 'middle' },
      right: { kind: 'default' },
    });

    await session.write({ buttons: { back: { kind: 'default' } } });
    expect([...blob.subarray(back, back + 7)]).toEqual([0x00, 0x08, 0, 0, 0, 0, 8]);
  });

  it('refuses actions the mouse cannot store', async () => {
    const { fake } = fakeEgg();
    const session = await driver.open(fake.asHid(), ctx);
    await expect(session.write({ buttons: { back: { kind: 'dpi', action: 'shift' } } })).rejects.toThrow(/DPI cycle/);
    await expect(session.write({ buttons: { back: { kind: 'scroll', direction: 'left' } } })).rejects.toThrow(/up or down/);
  });

  it('keeps switch mode and debounce in one byte', async () => {
    const { fake, blob } = fakeEgg();
    const session = await driver.open(fake.asHid(), ctx);
    const leftFilter = OFFSET.buttons + 6;
    await session.write({ extras: { leftSwitchMode: 'speed', rightDebounce: 3 } });
    expect(blob[leftFilter]).toBe(0xf1);
    expect(blob[leftFilter + 7]).toBe(3);
    await session.write({ extras: { leftDebounce: 5 } }); // ignored while GX is on
    expect(blob[leftFilter]).toBe(0xf1);
    await session.write({ extras: { leftSwitchMode: 'off', leftDebounce: 5 } });
    expect(blob[leftFilter]).toBe(5);
  });

  it('writes sensor toggles and the slam-click bit', async () => {
    const { fake, blob } = fakeEgg();
    const session = await driver.open(fake.asHid(), ctx);
    await session.write({ extras: { motionSync: true, forceMaxFps: true, slamclick: false, liftOffLed: false } });
    expect(blob[OFFSET.motionSync]).toBe(1);
    expect(blob[OFFSET.forceMaxFps]).toBe(1);
    expect(blob[OFFSET.filterFlags]! & 1).toBe(0);
    expect(blob[OFFSET.liftOffLed]).toBe(0);
  });

  it('keeps bindings it cannot show, and says so', async () => {
    const blob = factoryBlob();
    const back = OFFSET.buttons + 3 * 7;
    blob.set([0x0c, 0x01, 0x58, 0x02, 0x90, 0x01], back); // fixed CPI 600 / 400
    const { fake } = fakeEgg(blob);
    const session = await driver.open(fake.asHid(), ctx);
    expect(session.notices?.[0]?.message).toMatch(/Side back/);
    await session.write({ pollingRate: 500 });
    expect([...blob.subarray(back, back + 6)]).toEqual([0x0c, 0x01, 0x58, 0x02, 0x90, 0x01]);
  });

  it('reports a rejected store', async () => {
    const { fake } = fakeEgg(factoryBlob(), { storeStatus: 0x07 });
    const session = await driver.open(fake.asHid(), ctx);
    await expect(session.write({ pollingRate: 500 })).rejects.toThrow(/rejected/);
  });
});

describe('Endgame Gear protocol', () => {
  it('snaps DPI to what the sensor stores', () => {
    expect(snapDpi(10010)).toBe(10000);
    expect(snapDpi(10030)).toBe(10050);
    expect(snapDpi(1234)).toBe(1230);
    expect(snapDpi(5)).toBe(10);
  });

  it('frames replies with or without the id byte', () => {
    expect([...frameReport(new Uint8Array([0xa1, 0x01, 0x05]), 0xa1)]).toEqual([0xa1, 0x01, 0x05]);
    expect([...frameReport(new Uint8Array([0x01, 0x05]), 0xa1)]).toEqual([0xa1, 0x01, 0x05]);
    expect([...frameReport(new Uint8Array([0x00, 0x01, 0x05]), 0xa0)]).toEqual([0xa0, 0x01, 0x05]);
  });

  it('shows a non-standard polling divider as the nearest rate', () => {
    const blob = factoryBlob();
    blob[OFFSET.pollingDivider] = 3; // 2666 Hz
    const d = decode(blob);
    expect(d.settings.pollingRate).toBe(2000);
    expect(d.customPollingHz).toBe(2667);
  });

  it('declares only settings it decodes', () => {
    const s = decode(factoryBlob()).settings;
    expect(Object.keys(s.extras!).sort()).toEqual(capabilities.extras!.map((e) => e.id).sort());
    expect(Object.keys(s.buttons!)).toEqual(capabilities.buttons!.buttons.map((b) => b.id));
  });
});

describe('Endgame Gear open failures', () => {
  it('explains the udev rule on Linux', async () => {
    const { fake } = fakeEgg();
    fake.open = async () => {
      throw new DOMException('Failed to open the device.', 'NotAllowedError');
    };
    await expect(driver.open(fake.asHid(), ctx)).rejects.toThrow(/idVendor}=="3367".*udevadm/);
    await expect(driver.open(fake.asHid(), { platform: 'windows' })).rejects.toThrow(/Close the Endgame Gear software/);
  });
});
