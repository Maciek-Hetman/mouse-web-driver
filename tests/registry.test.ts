import { describe, expect, it } from 'vitest';
import { DriverRegistry, deviceMatchesFilter } from '../src/core/registry';
import type { MouseDriver } from '../src/core/types';
import { FakeHidDevice } from './fake-hid';

const driver = (id: string, filters: HIDDeviceFilter[], extra: Partial<MouseDriver> = {}): MouseDriver => ({
  id,
  name: id,
  filters,
  open: () => Promise.reject(new Error('not used')),
  ...extra,
});

// A Razer-style mouse exposes a keyboard interface and a mouse interface; only the latter carries control reports.
const razerKeyboardIf = new FakeHidDevice({ vendorId: 0x1532, productId: 0x00b2, collections: [{ usagePage: 0x01, usage: 0x06 }] }).asHid();
const razerMouseIf = new FakeHidDevice({ vendorId: 0x1532, productId: 0x00b2, collections: [{ usagePage: 0x01, usage: 0x02 }] }).asHid();
const logitechVendorIf = new FakeHidDevice({ vendorId: 0x046d, productId: 0xc09f, collections: [{ usagePage: 0xff00, usage: 0x01 }] }).asHid();

describe('deviceMatchesFilter', () => {
  it('matches on ids alone', () => {
    expect(deviceMatchesFilter(razerMouseIf, { vendorId: 0x1532 })).toBe(true);
    expect(deviceMatchesFilter(razerMouseIf, { vendorId: 0x1532, productId: 0x0099 })).toBe(false);
  });

  it('requires a collection with the given usage', () => {
    const f = { vendorId: 0x1532, usagePage: 0x01, usage: 0x02 };
    expect(deviceMatchesFilter(razerMouseIf, f)).toBe(true);
    expect(deviceMatchesFilter(razerKeyboardIf, f)).toBe(false);
    expect(deviceMatchesFilter(logitechVendorIf, { usagePage: 0xff00 })).toBe(true);
  });
});

describe('DriverRegistry', () => {
  const razer = driver('razer', [{ vendorId: 0x1532, usagePage: 0x01, usage: 0x02 }]);
  const logi = driver('logitech', [{ vendorId: 0x046d, usagePage: 0xff00 }]);
  const registry = new DriverRegistry([razer, logi]);

  it('unions filters for the chooser', () => {
    expect(registry.requestFilters()).toHaveLength(2);
  });

  it('picks the interface a driver can control', () => {
    expect(registry.pick([razerKeyboardIf, razerMouseIf])).toEqual({ driver: razer, device: razerMouseIf });
    expect(registry.pick([logitechVendorIf])?.driver).toBe(logi);
    expect(registry.pick([razerKeyboardIf])).toBeUndefined();
  });

  it('lets a driver override matching', () => {
    const picky = driver('picky', [{ vendorId: 0x1532 }], { matches: (d) => d.productId === 0x0099 });
    const r = new DriverRegistry([picky]);
    expect(r.find(razerMouseIf)).toBeUndefined();
  });

  it('rejects duplicate ids', () => {
    expect(() => new DriverRegistry([razer, razer])).toThrow(/Duplicate/);
  });
});
