// Shown for devices no driver claims. Dumps what WebHID can see, which is
// exactly what someone writing a new driver needs first.

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

export function diagnosticsView(devices: readonly HIDDevice[], onBack: () => void): HTMLElement {
  const summaries = devices.map(summariseDevice);
  const json = JSON.stringify(summaries, null, 2);
  const copy = h(
    'button',
    {
      onclick: async () => {
        await navigator.clipboard.writeText(json);
        copy.textContent = 'Copied';
      },
    },
    'Copy as JSON',
  );

  return h(
    'section',
    { class: 'card' },
    h('h2', null, 'No driver for this device yet'),
    h(
      'p',
      null,
      'Here is what the browser can see. If this is a mouse you want supported, paste this into an issue on the repository.',
    ),
    h('pre', { class: 'dump' }, json),
    h('div', { class: 'row' }, copy, h('button', { onclick: onBack }, 'Back')),
  );
}
