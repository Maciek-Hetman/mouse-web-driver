// Endgame Gear wired 8K mice (OP1 8k v2, XM2 8k v2) over the vendor HID
// collection on usage page 0xFF01. Blob layout and encoding live in
// ./endgame-gear/protocol.ts; this file handles the transport side.

import { HidTransport, TransportError, sleep } from '../core/transport';
import type { MouseDriver, MouseSettings, Notice, Platform } from '../core/types';
import {
  CMD,
  MODELS,
  REPORT_COMMAND,
  REPORT_CONFIG,
  STATUS,
  USAGE_PAGE,
  VENDOR_ID,
  applyChanges,
  capabilities,
  commandPacket,
  decode,
  frameReport,
  fullBlob,
  isValidBlob,
  parseFirmware,
  storePacket,
} from './endgame-gear/protocol';

// The device holds one reply at a time and doesn't tolerate pipelined
// commands, so every exchange runs inside transport.exclusive() and waits a
// little between the command and the read.
const REPLY_DELAY_MS = 60;
const STORE_SETTLE_MS = 300;

class EggDevice {
  constructor(private readonly t: HidTransport) {}

  private async receive(reportId: number): Promise<Uint8Array> {
    return frameReport(await this.t.receiveFeature(reportId), reportId);
  }

  private async command(cmd: number): Promise<void> {
    await this.t.sendFeature(REPORT_COMMAND, commandPacket(cmd));
    await sleep(REPLY_DELAY_MS);
  }

  /** Read the config blob. Some descriptors serve it on 0xA1, others on 0xA0, so try both. */
  readBlob(): Promise<Uint8Array> {
    return this.t.exclusive(async () => {
      let last = 'no reply';
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.command(CMD.load);
        for (const id of [REPORT_COMMAND, REPORT_CONFIG]) {
          try {
            const blob = await this.receive(id);
            if (isValidBlob(blob)) return fullBlob(blob);
            last = `report 0x${id.toString(16)}: ${blob.length} bytes, status 0x${(blob[1] ?? 0).toString(16)}`;
          } catch (err) {
            last = err instanceof Error ? err.message : String(err);
          }
        }
        await sleep(100 * (attempt + 1));
      }
      throw new TransportError(`The mouse didn't return its configuration (${last}).`);
    });
  }

  writeBlob(blob: Uint8Array): Promise<void> {
    return this.t.exclusive(async () => {
      await this.t.sendFeature(REPORT_CONFIG, storePacket(blob));
      await sleep(STORE_SETTLE_MS);
      // Wait out "busy". Only an explicit rejection is an error: the app reads
      // back after every write, so a silent failure still shows up there.
      for (let attempt = 0; attempt < 5; attempt++) {
        const reply = await this.receive(REPORT_COMMAND).catch(() => undefined);
        const status = reply?.[1];
        if (status === STATUS.rejected) throw new TransportError('The mouse rejected the new configuration.');
        if (status !== STATUS.busy) return;
        await sleep(150 * (attempt + 1));
      }
    });
  }

  readFirmware(): Promise<string | undefined> {
    return this.t.exclusive(async () => {
      await this.command(CMD.firmware);
      return parseFirmware(await this.receive(REPORT_COMMAND));
    });
  }
}

/** Chrome only says "Failed to open the device"; the cause is almost always one of these. */
function openFailureHint(platform: Platform, err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  if (platform === 'linux') {
    return (
      `${base} On Linux that means your user can't open /dev/hidraw* yet. ` +
      'Run the udev commands under "Linux: Failed to open the device?" on the start page, then replug the mouse.'
    );
  }
  return `${base} Close the Endgame Gear software and any other tab using the mouse, replug it, and try again.`;
}

const driver: MouseDriver = {
  id: 'endgame-gear',
  name: 'Endgame Gear (8K wired)',
  filters: MODELS.map((m) => ({ vendorId: VENDOR_ID, productId: m.productId, usagePage: USAGE_PAGE })),

  platformNotes(ctx) {
    if (ctx.platform === 'windows') {
      return [{ level: 'info', message: 'Endgame Gear: close the Endgame Gear software first, it holds the mouse open.' }];
    }
    return [];
  },

  async open(device, ctx) {
    const model = MODELS.find((m) => m.productId === device.productId);
    const t = new HidTransport(device);
    try {
      await t.open();
    } catch (err) {
      throw new Error(openFailureHint(ctx.platform, err));
    }
    const egg = new EggDevice(t);

    const firmware = await egg.readFirmware().catch(() => undefined);
    const first = decode(await egg.readBlob());

    const notices: Notice[] = [];
    if (model && !model.tested) {
      notices.push({ level: 'warning', message: `The ${model.name} uses the same protocol as the OP1 8k v2 but hasn't been tested yet.` });
    }
    if (first.customPollingHz !== undefined) {
      notices.push({
        level: 'info',
        message: `The mouse uses a non-standard polling rate (${first.customPollingHz} Hz), shown as the nearest one. Choosing a rate here replaces it.`,
      });
    }
    if (first.unknownButtons.length > 0) {
      notices.push({
        level: 'info',
        message:
          `${first.unknownButtons.join(', ')}: bound to something this app can't show yet (e.g. a fixed DPI), so it appears as Default. ` +
          'It is kept unless you pick a new action.',
      });
    }

    return {
      info: { name: model?.name ?? device.productName, vendor: 'Endgame Gear', firmware, connection: 'wired' },
      capabilities,
      notices,

      async read(): Promise<MouseSettings> {
        return decode(await egg.readBlob()).settings;
      },

      async write(changes) {
        // Start from a fresh read so anything changed on the mouse itself
        // (the DPI button) since the last read isn't reverted.
        const before = await egg.readBlob();
        const after = applyChanges(before, changes);
        if (after.every((b, i) => b === before[i])) return;
        await egg.writeBlob(after);
      },

      close: () => t.close(),
    };
  },
};

export default driver;
