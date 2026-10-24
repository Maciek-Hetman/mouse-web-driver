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
