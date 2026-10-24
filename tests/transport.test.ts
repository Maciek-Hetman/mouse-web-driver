import { describe, expect, it } from 'vitest';
import { HidTransport, TransportError, sleep } from '../src/core/transport';
import { FakeHidDevice } from './fake-hid';

describe('HidTransport', () => {
  it('runs exclusive transactions one at a time, even after a failure', async () => {
    const t = new HidTransport(new FakeHidDevice({ vendorId: 1, productId: 2 }).asHid());
    const log: string[] = [];
    const a = t.exclusive(async () => {
      log.push('a start');
      await sleep(20);
      log.push('a end');
      throw new Error('a failed');
    });
    const b = t.exclusive(async () => {
      log.push('b');
      return 42;
    });
    await expect(a).rejects.toThrow('a failed');
    await expect(b).resolves.toBe(42);
    expect(log).toEqual(['a start', 'a end', 'b']);
  });

  it('does a feature-report set/get round trip (Razer / Endgame Gear style)', async () => {
    const fake = new FakeHidDevice({
      vendorId: 0x3367,
      productId: 0x1978,
      onFeature: (id, data) => (id === 0xa1 ? new Uint8Array([0xa0, data[0]! + 1]) : undefined),
    });
    const t = new HidTransport(fake.asHid());
    await t.open();
    const reply = await t.exclusive(async () => {
      await t.sendFeature(0xa1, new Uint8Array([7]));
      return t.receiveFeature(0xa0);
    });
    expect([...reply]).toEqual([0xa0, 8]);
    expect(fake.opened).toBe(true);
  });

  it('matches an input report to an output request (HID++ style)', async () => {
    const fake = new FakeHidDevice({
      vendorId: 0x046d,
      productId: 0xc09f,
      collections: [{ usagePage: 0xff00, usage: 0x01 }],
      onOutput: (_id, data) => [
        { reportId: 0x11, data: new Uint8Array([0xff, 0x09, 0x00]) }, // unrelated notification
        { reportId: 0x11, data: new Uint8Array([data[0]!, data[1]!, 0xaa]) },
      ],
    });
    const t = new HidTransport(fake.asHid());
    const res = await t.request(
      () => t.sendReport(0x10, new Uint8Array([0x01, 0x05, 0x00])),
      (id, view) => id === 0x11 && view.getUint8(0) === 0x01 && view.getUint8(1) === 0x05,
    );
    expect(res.data.getUint8(2)).toBe(0xaa);
  });

  it('times out when nothing answers', async () => {
    const t = new HidTransport(new FakeHidDevice({ vendorId: 1, productId: 2 }).asHid(), { timeoutMs: 20 });
    await expect(t.request(() => t.sendReport(0x10, new Uint8Array(6)), () => true)).rejects.toBeInstanceOf(TransportError);
  });
});
