import type { MouseDriver } from './types';

/** Same semantics as the browser's chooser: ids must match, and if a usage is given some collection must have it. */
export function deviceMatchesFilter(device: HIDDevice, filter: HIDDeviceFilter): boolean {
  if (filter.vendorId !== undefined && filter.vendorId !== device.vendorId) return false;
  if (filter.productId !== undefined && filter.productId !== device.productId) return false;
  if (filter.usagePage === undefined && filter.usage === undefined) return true;
  return device.collections.some(
    (c) =>
      (filter.usagePage === undefined || c.usagePage === filter.usagePage) &&
      (filter.usage === undefined || c.usage === filter.usage),
  );
}

export function driverMatches(driver: MouseDriver, device: HIDDevice): boolean {
  if (driver.matches) return driver.matches(device);
  return driver.filters.some((f) => deviceMatchesFilter(device, f));
}

export interface DriverMatch {
  driver: MouseDriver;
  device: HIDDevice;
}

export class DriverRegistry {
  private readonly drivers: MouseDriver[] = [];

  constructor(drivers: Iterable<MouseDriver> = []) {
    for (const d of drivers) this.register(d);
  }

  register(driver: MouseDriver): void {
    if (this.drivers.some((d) => d.id === driver.id)) {
      throw new Error(`Duplicate driver id "${driver.id}"`);
    }
    this.drivers.push(driver);
  }

  get all(): readonly MouseDriver[] {
    return this.drivers;
  }

  /** Union of all drivers' filters, for navigator.hid.requestDevice(). */
  requestFilters(): HIDDeviceFilter[] {
    return this.drivers.flatMap((d) => d.filters);
  }

  find(device: HIDDevice): MouseDriver | undefined {
    return this.drivers.find((d) => driverMatches(d, device));
  }

  /**
   * The chooser can hand back several HIDDevices for one mouse (one per
   * interface or, on Windows, one per top-level collection). Return the first
   * one some driver can control.
   */
  pick(devices: readonly HIDDevice[]): DriverMatch | undefined {
    return this.candidates(devices)[0];
  }

  /**
   * Every HIDDevice some driver claims, best first. Several interfaces of one
   * mouse can look alike (a Razer receiver shows two identical ones and only
   * one answers), so the app tries them in this order. Drivers can rank their
   * interfaces with `preference()`; ties keep the browser's order.
   */
  candidates(devices: readonly HIDDevice[]): DriverMatch[] {
    const out: { match: DriverMatch; score: number; order: number }[] = [];
    devices.forEach((device, order) => {
      const driver = this.find(device);
      if (driver) out.push({ match: { driver, device }, score: driver.preference?.(device) ?? 0, order });
    });
    return out.sort((a, b) => b.score - a.score || a.order - b.order).map((c) => c.match);
  }
}
