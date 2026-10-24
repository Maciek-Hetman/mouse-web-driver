// Errors drivers throw from open() so the app can react sensibly.

/**
 * This HIDDevice is not the mouse's control interface (it never answered the
 * probe). The app quietly moves on to the next interface the user granted.
 */
export class InterfaceMismatchError extends Error {
  override name = 'InterfaceMismatchError';
}

/**
 * The browser or OS refused to let us talk to the control interface at all.
 * `message` is written for the user and says what to do about it.
 */
export class DeviceAccessError extends Error {
  override name = 'DeviceAccessError';
}

/** True for the DOMExceptions WebHID throws when a report is blocked or the OS rejects it. */
export function isHidAccessDenied(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'NotSupportedError' || err.name === 'NetworkError' || err.name === 'SecurityError');
}

/**
 * Message for when HIDDevice.open() itself fails. On Linux that almost always
 * means the hidraw node is root-only and needs a udev rule.
 */
export function openFailedMessage(platform: string, vendorId: number, vendor: string): string {
  const vid = vendorId.toString(16).padStart(4, '0');
  if (platform === 'linux') {
    return (
      `Linux didn't let the browser open the ${vendor} device. Add a udev rule so your user can open it: put ` +
      `KERNEL=="hidraw*", ATTRS{idVendor}=="${vid}", TAG+="uaccess" in /etc/udev/rules.d/70-mouse-web-driver.rules, ` +
      'run "sudo udevadm control --reload && sudo udevadm trigger", then replug the mouse (or receiver) and connect again.'
    );
  }
  if (platform === 'macos') {
    return (
      `macOS didn't let the browser open the ${vendor} device. Give the browser Input Monitoring permission ` +
      '(System Settings → Privacy & Security → Input Monitoring), restart it, then connect again.'
    );
  }
  return `The browser couldn't open the ${vendor} device. Close ${vendor === 'Razer' ? 'Razer Synapse' : 'G HUB'} or anything else using it, replug it, then connect again.`;
}

/** Open the device, turning a refusal into a DeviceAccessError with platform advice. */
export async function openOrExplain(device: HIDDevice, platform: string, vendor: string): Promise<void> {
  if (device.opened) return;
  try {
    await device.open();
  } catch (err) {
    if (err instanceof DOMException) throw new DeviceAccessError(openFailedMessage(platform, device.vendorId, vendor));
    throw err;
  }
}
