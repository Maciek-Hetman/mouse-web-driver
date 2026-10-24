// Linux only lets root open /dev/hidraw* by default, and Chrome reports that
// as a bare "Failed to open the device". This panel gives the one-time fix: a
// udev rule covering every vendor a bundled driver talks to.

import type { MouseDriver } from '../core/types';
import { h } from './dom';

export const UDEV_RULES_PATH = '/etc/udev/rules.d/70-mouse-web-driver.rules';

/** Vendor ids from the drivers' chooser filters, as lowercase 4-digit hex. */
export function driverVendorIds(drivers: readonly MouseDriver[]): string[] {
  const ids = new Set<string>();
  for (const d of drivers) {
    for (const f of d.filters) {
      if (f.vendorId !== undefined) ids.add(f.vendorId.toString(16).padStart(4, '0'));
    }
  }
  return [...ids].sort();
}

export function udevCommands(vendorIds: readonly string[]): string {
  const rules = vendorIds.map((vid) => `KERNEL=="hidraw*", ATTRS{idVendor}=="${vid}", TAG+="uaccess"`);
  return [
    `sudo tee ${UDEV_RULES_PATH} > /dev/null <<'EOF'`,
    ...rules,
    'EOF',
    'sudo udevadm control --reload && sudo udevadm trigger',
  ].join('\n');
}

/** Collapsible help; `open` expands it, e.g. right after connecting failed. */
export function linuxAccessHelp(drivers: readonly MouseDriver[], open: boolean): HTMLElement | null {
  const vendorIds = driverVendorIds(drivers);
  if (vendorIds.length === 0) return null;
  const commands = udevCommands(vendorIds);

  const copy = h('button', {
    class: 'primary',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(commands);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Copy failed, select the text instead';
      }
      setTimeout(() => (copy.textContent = 'Copy setup commands'), 2000);
    },
  }, 'Copy setup commands');

  return h(
    'details',
    { class: 'linux-access', open },
    h('summary', null, 'Linux: "Failed to open the device"?'),
    h(
      'p',
      null,
      'Linux only lets root open mice as raw HID devices. Press the button, paste into a terminal and enter your ' +
        'password. Then unplug and replug the mouse (or its receiver) and connect again. You only need to do this once.',
    ),
    h('div', { class: 'row' }, copy),
    h('pre', { class: 'dump' }, commands),
  );
}
