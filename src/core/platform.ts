import type { Platform } from './types';

interface UADataNavigator {
  userAgentData?: { platform?: string };
}

export function detectPlatform(nav: Navigator = navigator): Platform {
  const hint = ((nav as UADataNavigator).userAgentData?.platform ?? nav.userAgent).toLowerCase();
  if (hint.includes('android')) return 'android';
  if (hint.includes('cros') || hint.includes('chrome os')) return 'chromeos';
  if (hint.includes('win')) return 'windows';
  if (hint.includes('mac')) return 'macos';
  if (hint.includes('linux')) return 'linux';
  return 'unknown';
}

export type WebHidSupport = { ok: true } | { ok: false; reason: string };

export function webHidSupport(win: Window = window): WebHidSupport {
  if (!win.isSecureContext) {
    return { ok: false, reason: 'WebHID needs a secure context. Open this page over https:// or from localhost.' };
  }
  if (!('hid' in win.navigator)) {
    return {
      ok: false,
      reason: 'This browser has no WebHID. Use a desktop Chromium browser (Chrome, Edge, Brave, Opera, Vivaldi).',
    };
  }
  return { ok: true };
}
