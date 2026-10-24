// Razer mice over the 90-byte feature-report protocol (src/protocols/razer.ts).
//
// The control channel lives on the plain Mouse interface. Chrome lets pages
// send feature reports there on Linux and macOS, but reportedly blocks it on
// Windows since Chrome 153, so open() turns that failure into a clear message.

import { DeviceAccessError, InterfaceMismatchError, isHidAccessDenied, openOrExplain } from '../core/errors';
import { HidTransport, TransportError } from '../core/transport';
import type { Capabilities, DeviceInfo, DriverContext, ExtraSetting, MouseDriver, MouseSession, MouseSettings, Notice, Platform } from '../core/types';
import * as razer from '../protocols/razer';

const VENDOR_ID = 0x1532;

interface Model {
  productId: number;
  name: string;
  connection: DeviceInfo['connection'];
  maxDpi: number;
  polling: razer.PollingCommand;
  /** Battery-powered (reports charge, has a sleep timer). */
  wireless: boolean;
  /** Tilt wheel with free-spin, acceleration and Smart Reel. */
  hyperScroll: boolean;
}

export const MODELS: Model[] = [
  { productId: 0x00b2, name: 'DeathAdder V3', connection: 'wired', maxDpi: 30000, polling: 'extended', wireless: false, hyperScroll: false },
  { productId: 0x00c4, name: 'DeathAdder V3 HyperSpeed', connection: 'wired', maxDpi: 26000, polling: 'legacy', wireless: true, hyperScroll: false },
  { productId: 0x00c5, name: 'DeathAdder V3 HyperSpeed', connection: 'receiver', maxDpi: 26000, polling: 'legacy', wireless: true, hyperScroll: false },
  { productId: 0x0099, name: 'Basilisk V3', connection: 'wired', maxDpi: 26000, polling: 'legacy', wireless: false, hyperScroll: true },
];

const modelFor = (device: HIDDevice) =>
  device.vendorId === VENDOR_ID ? MODELS.find((m) => m.productId === device.productId) : undefined;

const SLEEP_OPTIONS = [60, 120, 180, 300, 600, 900];

const EXTRAS: Record<string, ExtraSetting> = {
  sleep: {
    type: 'select',
    id: 'sleep',
    label: 'Sleep after',
    group: 'Power',
    description: 'How long the mouse waits without movement before it goes to sleep.',
    options: SLEEP_OPTIONS.map((s) => ({ value: String(s), label: `${s / 60} minute${s === 60 ? '' : 's'}` })),
  },
  freeSpin: { type: 'toggle', id: 'freeSpin', label: 'Free-spin wheel', group: 'Scroll wheel', description: 'Off is the tactile, notched mode.' },
  acceleration: { type: 'toggle', id: 'acceleration', label: 'Scroll acceleration', group: 'Scroll wheel' },
  smartReel: {
    type: 'toggle',
    id: 'smartReel',
    label: 'Smart Reel',
    group: 'Scroll wheel',
    description: 'Switches to free-spin automatically when you flick the wheel.',
  },
};

/** What to tell the user when Chrome or the OS refuses the control interface. */
export function accessMessage(platform: Platform): string {
  switch (platform) {
    case 'windows':
      return (
        'Chrome on Windows refused to talk to the Razer control interface. Recent Chrome versions (153 and later) ' +
        'reportedly block it, and there is no browser-side workaround yet. The same mouse works from Chrome on Linux ' +
        'and macOS. To help us confirm this, open chrome://device-log, look for "Access is denied" next to the mouse, ' +
        'and include it with the debug report below.'
      );
    case 'linux':
      return (
        'Linux refused access to the mouse. Add a udev rule so your user can open Razer hidraw devices: ' +
        'KERNEL=="hidraw*", ATTRS{idVendor}=="1532", TAG+="uaccess" (for example in /etc/udev/rules.d/70-razer.rules), ' +
        'then run "sudo udevadm control --reload && sudo udevadm trigger" and replug the mouse. Close OpenRazer\'s ' +
        'daemon if it is running.'
      );
    case 'macos':
      return (
        'macOS refused access to the mouse. Give your browser Input Monitoring permission (System Settings → ' +
        'Privacy & Security → Input Monitoring), quit and reopen the browser, then connect again.'
      );
    default:
      return 'The browser refused access to the Razer control interface.';
  }
}

const driver: MouseDriver = {
  id: 'razer',
  name: 'Razer: DeathAdder V3, DeathAdder V3 HyperSpeed, Basilisk V3',
  filters: MODELS.map((m) => ({ vendorId: VENDOR_ID, productId: m.productId })),

  matches: (device) => modelFor(device) !== undefined,

  // Each USB interface (on Windows, each collection) is a separate HIDDevice.
  // The control channel is normally on the Mouse collection, so try that first;
  // the others are still tried because the Basilisk V3 uses interface 3.
  preference: (device) => (device.collections.some((c) => c.usagePage === 0x01 && c.usage === 0x02) ? 1 : 0),

  platformNotes(ctx) {
    if (ctx.platform === 'windows') {
      return [
        {
          level: 'warning',
          message:
            'Razer on Windows: recent Chrome versions reportedly block the interface Razer mice are configured through. ' +
            'Try it anyway; if it is blocked you will get a clear message and a debug report to send us.',
        },
      ];
    }
    if (ctx.platform === 'linux') {
      return [{ level: 'info', message: 'Razer on Linux needs a udev rule for vendor 1532 (see the README).' }];
    }
    return [];
  },

  async open(device, ctx) {
    const model = modelFor(device);
    if (!model) throw new InterfaceMismatchError('Not a supported Razer mouse.');
    const transport = new HidTransport(device);
    await openOrExplain(device, ctx.platform, 'Razer');
    const conn = new razer.RazerConnection(transport, {
      // The dongle relays to the mouse over the air; give it time.
      replyDelayMs: model.connection === 'receiver' ? 15 : 3,
      replyTimeoutMs: model.connection === 'receiver' ? 1000 : 300,
    });

    let firmware: string;
    try {
      firmware = await razer.getFirmware(conn);
    } catch (err) {
      await transport.close().catch(() => undefined);
      if (isHidAccessDenied(err)) throw new DeviceAccessError(accessMessage(ctx.platform));
      if (err instanceof TransportError) {
        throw new InterfaceMismatchError(
          model.connection === 'receiver'
            ? 'The receiver did not answer. Make sure the mouse is switched on and in HyperSpeed (dongle) mode, move it to wake it, then connect again.'
            : `The ${model.name} did not answer on any interface. Close Razer Synapse if it is running, replug the mouse, then connect again.`,
        );
      }
      if (err instanceof razer.RazerError && err.status === razer.Status.Timeout) {
        throw new Error('The receiver answered but the mouse did not. Switch the mouse on or move it to wake it, then connect again.');
      }
      throw err;
    }

    return createSession(model, conn, firmware);
  },
};

export default driver;

async function optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof razer.RazerError) return undefined;
    throw err;
  }
}

async function createSession(model: Model, conn: razer.RazerConnection, firmware: string): Promise<MouseSession> {
  const serial = await optional(() => razer.getSerial(conn));

  // Polling: fall back to the legacy command if the extended one is refused.
  let polling = model.polling;
  if (polling === 'extended' && (await optional(() => razer.getPollingRate(conn, 'extended'))) === undefined) polling = 'legacy';

  // Only offer extras the firmware actually answers.
  const extras: ExtraSetting[] = [];
  if (model.wireless && (await optional(() => razer.getIdleTime(conn))) !== undefined) extras.push(EXTRAS.sleep!);
  if (model.hyperScroll) {
    for (const id of ['freeSpin', 'acceleration', 'smartReel'] as const) {
      if ((await optional(() => razer.getWheel(conn, id))) !== undefined) extras.push(EXTRAS[id]!);
    }
  }

  const capabilities: Capabilities = {
    dpi: { min: 100, max: model.maxDpi, step: 1, maxStages: 5, perAxis: true },
    pollingRate: { rates: razer.pollingRates(polling) },
    extras: extras.length ? extras : undefined,
  };

  const notices: Notice[] = [
    {
      level: 'info',
      message: 'Button remapping and lift-off distance for Razer mice are not supported yet; they need a USB capture from Synapse to decode.',
    },
  ];

  let lastTable: razer.StageTable | undefined;

  const info: DeviceInfo = { name: model.name, vendor: 'Razer', firmware, serial: serial || undefined, connection: model.connection };

  const session: MouseSession = {
    info,
    capabilities,
    notices,

    async read() {
      const table = (await optional(() => razer.getDpiStages(conn))) ?? { activeId: 1, stages: [] };
      lastTable = table;
      const settings: MouseSettings = {};
      let active = table.stages.findIndex((s) => s.id === table.activeId);
      if (table.stages.length > 0) {
        settings.dpi = {
          stages: table.stages.map((s) => (s.y && s.y !== s.x ? { x: s.x, y: s.y } : { x: s.x })),
          active: Math.max(0, active),
        };
      } else {
        // No stage table stored: show the current DPI as a single stage.
        const dpi = await razer.getDpi(conn);
        active = 0;
        settings.dpi = { stages: [dpi.y !== dpi.x ? { x: dpi.x, y: dpi.y } : { x: dpi.x }], active };
      }
      settings.pollingRate = await razer.getPollingRate(conn, polling);

      const values: Record<string, boolean | string> = {};
      for (const e of extras) {
        if (e.id === 'sleep') values.sleep = nearestSleep(await razer.getIdleTime(conn));
        else values[e.id] = await razer.getWheel(conn, e.id as razer.WheelSetting);
      }
      if (extras.length) settings.extras = values;

      if (model.wireless) {
        const percent = await optional(() => razer.getBattery(conn));
        const charging = await optional(() => razer.getCharging(conn));
        info.battery = percent === undefined ? undefined : { percent, charging };
      }
      return settings;
    },

    async write(changes) {
      if (changes.dpi) {
        const { stages, active } = changes.dpi;
        const previous = lastTable?.stages ?? [];
        const table: razer.StageTable = {
          activeId: active + 1,
          stages: stages.map((s, i) => ({ id: i + 1, x: s.x, y: s.y ?? s.x, tail: previous[i]?.tail ?? [0, 0] })),
        };
        await razer.setDpiStages(conn, table);
        // Some firmware only applies the active stage on the next button press; set it directly too.
        const current = stages[active]!;
        await razer.setDpi(conn, current.x, current.y ?? current.x);
      }
      if (changes.pollingRate !== undefined) await razer.setPollingRate(conn, polling, changes.pollingRate);
      for (const [id, value] of Object.entries(changes.extras ?? {})) {
        if (id === 'sleep') await razer.setIdleTime(conn, Number(value));
        else await razer.setWheel(conn, id as razer.WheelSetting, value === true);
      }
    },

    async refreshInfo() {
      if (model.wireless) {
        const percent = await optional(() => razer.getBattery(conn));
        if (percent !== undefined) info.battery = { percent, charging: await optional(() => razer.getCharging(conn)) };
      }
      return info;
    },

    async diagnostics() {
      return {
        model: model.name,
        productId: model.productId,
        pollingCommand: polling,
        transactionId: conn.txn,
        stageTable: lastTable,
        extras: extras.map((e) => e.id),
      };
    },

    close: () => conn.transport.close(),
  };
  return session;
}

function nearestSleep(seconds: number): string {
  const best = SLEEP_OPTIONS.reduce((a, b) => (Math.abs(b - seconds) < Math.abs(a - seconds) ? b : a));
  return String(best);
}
