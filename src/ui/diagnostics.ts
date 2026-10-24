// Debug reports: what WebHID can see of a device, plus the recent traffic.
// Shown for devices no driver claims, after a failed connect, and on demand
// from the device screen. This is how we debug mice we don't have.

import { traffic } from '../core/transport';
import { h, hex } from './dom';

interface CollectionSummary {
  usagePage: string;
  usage: string;
  inputReports: number[];
  outputReports: number[];
  featureReports: number[];
  children: CollectionSummary[];
}

export interface DeviceSummary {
  productName: string;
  vendorId: string;
  productId: string;
  collections: CollectionSummary[];
}

function summariseCollection(c: HIDCollectionInfo): CollectionSummary {
  const ids = (reports?: HIDReportInfo[]) => (reports ?? []).map((r) => r.reportId ?? 0);
  return {
    usagePage: hex(c.usagePage ?? 0),
    usage: hex(c.usage ?? 0),
    inputReports: ids(c.inputReports),
    outputReports: ids(c.outputReports),
    featureReports: ids(c.featureReports),
    children: (c.children ?? []).map(summariseCollection),
  };
}

export function summariseDevice(device: HIDDevice): DeviceSummary {
  return {
    productName: device.productName,
    vendorId: hex(device.vendorId),
    productId: hex(device.productId),
    collections: device.collections.map(summariseCollection),
  };
}

export interface ReportContext {
  platform: string;
  error?: string;
  driver?: string;
  session?: unknown;
}

/** Everything a bug report needs: browser, devices, the error and the recent HID traffic. */
export function buildReport(devices: readonly HIDDevice[], context: ReportContext): string {
  return JSON.stringify(
    {
      generated: new Date().toISOString(),
      userAgent: navigator.userAgent,
      ...context,
      devices: devices.map(summariseDevice),
      traffic: traffic.all,
    },
    null,
    2,
  );
}

export function copyButton(label: string, text: () => Promise<string> | string, onText?: (text: string) => void): HTMLButtonElement {
  const button = h(
    'button',
    {
      onclick: async () => {
        const value = await text();
        onText?.(value);
        try {
          await navigator.clipboard.writeText(value);
          button.textContent = 'Copied';
        } catch {
          button.textContent = 'Copy failed: select the text below';
        }
      },
    },
    label,
  );
  return button;
}

/** Shown for devices no driver claims, and when connecting failed. */
export function diagnosticsView(devices: readonly HIDDevice[], context: ReportContext, onBack: () => void, help?: HTMLElement | null): HTMLElement {
  const json = buildReport(devices, context);
  const failed = context.error !== undefined;

  return h(
    'section',
    { class: 'card' },
    h('h2', null, failed ? 'Couldn’t connect' : 'No driver for this device yet'),
    failed ? h('div', { class: 'notices' }, h('div', { class: 'notice error', role: 'alert' }, context.error)) : null,
    failed ? help : null,
    h(
      'p',
      null,
      failed
        ? 'If this keeps happening, copy the report below (it includes the last packets sent to the mouse) and paste it into an issue on the repository.'
        : 'Here is what the browser can see. If this is a mouse you want supported, paste this into an issue on the repository.',
    ),
    h('pre', { class: 'dump' }, json),
    h('div', { class: 'row' }, copyButton('Copy as JSON', () => json), h('button', { onclick: onBack }, 'Back')),
  );
}
