import { describe, expect, it } from 'vitest';
import driver from '../src/drivers/endgame-gear';
import type { MouseDriver } from '../src/core/types';
import { driverVendorIds, udevCommands } from '../src/ui/linux-access';

describe('Linux access help', () => {
  it('collects each vendor id once, from every driver', () => {
    const other = { ...driver, id: 'other', filters: [{ vendorId: 0x1532 }, { vendorId: 0x1532, productId: 1 }] } as MouseDriver;
    expect(driverVendorIds([driver, other])).toEqual(['1532', '3367']);
  });

  it('writes one rule per vendor and reloads udev', () => {
    const cmd = udevCommands(['046d', '3367']);
    expect(cmd).toContain(`KERNEL=="hidraw*", ATTRS{idVendor}=="046d", TAG+="uaccess"`);
    expect(cmd).toContain(`ATTRS{idVendor}=="3367"`);
    expect(cmd.split('\n').at(-1)).toBe('sudo udevadm control --reload && sudo udevadm trigger');
  });
});
