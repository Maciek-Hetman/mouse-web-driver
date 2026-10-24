// Logitech mice over HID++ 2.0 (src/protocols/hidpp.ts), on a cable or behind
// a Lightspeed receiver. Tested target: G Pro X Superlight 2c.
//
// Two ways to change settings, picked per device in open():
//   - Onboard profile (preferred): DPI stages, report rate and buttons are
//     written into the active profile in the mouse's flash, so they persist
//     and the DPI button keeps cycling stages. Needs a profile format we know.
//   - Live: DPI and report rate through 0x2201/0x2202 and 0x8060/0x8061. Takes
//     effect at once but the mouse may revert on power cycle or profile switch.

import { InterfaceMismatchError } from '../core/errors';
import { HidTransport } from '../core/transport';
import type { ButtonAction, Capabilities, DeviceInfo, MouseDriver, MouseSession, MouseSettings, Notice } from '../core/types';
import * as hidpp from '../protocols/hidpp';
import { Feature, HidppDevice } from '../protocols/hidpp';
import * as profiles from '../protocols/hidpp-profiles';

const VENDOR_ID = 0x046d;

/** Lightspeed / Unifying / Bolt receivers; the mouse sits at index 1-6 behind these. */
const RECEIVER_IDS = new Set([0xc52b, 0xc532, 0xc539, 0xc53a, 0xc53f, 0xc545, 0xc547, 0xc548, 0xc54d]);

const DEVICE_INDEXES = [0xff, 1, 2, 3, 4, 5, 6];

const LOD_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const BUTTON_LABELS = ['Left button', 'Right button', 'Wheel click', 'Side back', 'Side forward'];
const BUTTON_IDS = ['left', 'right', 'middle', 'back', 'forward'];

const hasLongHidpp = (device: HIDDevice) => device.collections.some((c) => c.usagePage === 0xff00 && c.usage === 0x02);

const driver: MouseDriver = {
  id: 'logitech',
  name: 'Logitech HID++ 2.0 mice (G Pro X Superlight 2c and similar), wired or via Lightspeed',
  filters: [{ vendorId: VENDOR_ID, usagePage: 0xff00 }],

  // HID++ answers on the long-report collection. On Windows the short and long
  // collections are separate HIDDevices; elsewhere one HIDDevice carries both.
  matches: (device) => device.vendorId === VENDOR_ID && hasLongHidpp(device),

  async open(device) {
    const transport = new HidTransport(device);
    await transport.open();
    try {
      const found = await findMouse(transport, RECEIVER_IDS.has(device.productId));
      if (!found) {
        throw new InterfaceMismatchError(
          RECEIVER_IDS.has(device.productId)
            ? 'The receiver is there but no mouse answered behind it. Switch the mouse on, move it to wake it, then connect again.'
            : 'No HID++ 2.0 mouse answered on this interface. Close G HUB if it is running, replug the mouse, then connect again.',
        );
      }
      return await createSession(device, found.mouse, found.version, found.probes);
    } catch (err) {
      await transport.close().catch(() => undefined);
      throw err;
    }
  },
};

export default driver;

interface Probe {
  index: string;
  version?: string;
  configurable?: boolean;
}

/** Find the device index of a configurable HID++ 2.0 mouse on this interface. */
async function findMouse(transport: HidTransport, isReceiver: boolean) {
  const probes: Probe[] = [];
  // A receiver can answer at 0xFF itself, so behind one try the paired slots first.
  const order = isReceiver ? [...DEVICE_INDEXES.slice(1), 0xff] : DEVICE_INDEXES;
  for (const index of order) {
    const mouse = new HidppDevice(transport, index);
    const version = await mouse.ping(isReceiver ? 600 : 300);
    const probe: Probe = { index: `0x${index.toString(16)}`, version: version && `${version.major}.${version.minor}` };
    probes.push(probe);
    if (!version || version.major < 2) continue;
    const ids = [Feature.AdjustableDpi, Feature.ExtendedDpi, Feature.ReportRate, Feature.ExtendedReportRate, Feature.OnboardProfiles];
    let configurable = false;
    for (const id of ids) if (await mouse.has(id)) configurable = true;
    probe.configurable = configurable;
    if (configurable) return { mouse, version, probes };
  }
  return undefined;
}

const lodName = (n: number | undefined) => (n === undefined ? undefined : (['low', 'medium', 'high'][n] ?? undefined));
const lodValue = (s: string) => Math.max(0, ['low', 'medium', 'high'].indexOf(s));

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function nearest(values: number[], target: number): number {
  return values.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

interface ProfileState {
  info: profiles.ProfilesInfo;
  directory: profiles.ProfileDirectory;
  /** Sector the mouse reports as active. */
  sector: number;
  /** Raw sector bytes as last read. */
  bytes: Uint8Array;
}

async function createSession(device: HIDDevice, mouse: HidppDevice, version: { major: number; minor: number }, probes: Probe[]): Promise<MouseSession> {
  const notices: Notice[] = [];
  const [name, firmware, dpiInfo, rateInfo] = [
    await hidpp.getDeviceName(mouse),
    await hidpp.getFirmware(mouse),
    await hidpp.getDpiInfo(mouse),
    await hidpp.getRateInfo(mouse),
  ];

  // Onboard profiles: only used when the layout is one we know and the CRC checks out.
  let profile: ProfileState | undefined;
  let profilesInfo: profiles.ProfilesInfo | undefined;
  let mode: number | undefined;
  let profileProblem: string | undefined;
  if (await mouse.has(Feature.OnboardProfiles)) {
    profilesInfo = await profiles.getProfilesInfo(mouse);
    if (!profiles.isSupportedFormat(profilesInfo)) {
      profileProblem = `onboard profile format ${profilesInfo.format} (memory model ${profilesInfo.memoryModel}) is not one we can edit yet`;
    } else {
      mode = await profiles.getMode(mouse);
      const directory = await profiles.readDirectory(mouse, profilesInfo);
      const sector = await profiles.getCurrentProfile(mouse);
      const bytes = await profiles.readSector(mouse, sector, profilesInfo.sectorSize);
      if (!directory.entries.some((e) => e.sector === sector)) profileProblem = `active profile sector 0x${sector.toString(16)} is not in the profile list`;
      else if (!profiles.crcOk(bytes)) profileProblem = 'the active profile failed its checksum';
      else profile = { info: profilesInfo, directory, sector, bytes };
    }
  }

  if (!dpiInfo && !rateInfo && !profile) throw new Error('This Logitech device has no DPI, report rate or onboard profile features we can use.');

  const isReceiver = mouse.index !== 0xff;
  const info: DeviceInfo = {
    name: name || device.productName || 'Logitech mouse',
    vendor: 'Logitech',
    firmware,
    connection: isReceiver ? 'receiver' : 'wired',
  };

  const dpiValues = dpiInfo?.values ?? [];
  const capabilities: Capabilities = {};
  if (dpiValues.length) {
    const min = dpiValues[0]!;
    const step = dpiValues.slice(1).reduce((g, v) => gcd(g, v - min), 0) || 1;
    capabilities.dpi = {
      min,
      max: dpiValues[dpiValues.length - 1]!,
      step,
      maxStages: profile ? profiles.MAX_DPI_SLOTS : 1,
      perAxis: !profile && (dpiInfo?.perAxis ?? false),
    };
  }
  if (rateInfo) {
    // Profiles store whole milliseconds, so only rates up to 1000 Hz fit there.
    const rates = profile ? rateInfo.rates.filter((r) => r <= 1000 && Number.isInteger(1000 / r)) : rateInfo.rates;
    if (rates.length) capabilities.pollingRate = { rates };
    if (profile && rates.length < rateInfo.rates.length) {
      notices.push({
        level: 'info',
        message: `Report rates above 1000 Hz aren't wired up for onboard profiles yet (the mouse lists ${rateInfo.rates.join(', ')} Hz).`,
      });
    }
  }
  if (dpiInfo?.lod) {
    capabilities.lod = { options: LOD_OPTIONS };
    notices.push({ level: 'info', message: 'Lift-off distance is set live and may reset when the mouse powers off.' });
  }

  let buttonFallback: Uint8Array[] = [];
  if (profile) {
    const count = Math.min(profile.info.buttonCount, 16);
    buttonFallback = Array.from({ length: count }, (_, i) => profiles.profileButton(profile!.bytes, i));
    capabilities.buttons = {
      buttons: Array.from({ length: count }, (_, i) => ({
        id: BUTTON_IDS[i] ?? `button${i + 1}`,
        label: BUTTON_LABELS[i] ?? `Button ${i + 1}`,
        // Losing left click with no other way to click is a bad afternoon.
        remappable: i !== 0,
      })),
      actions: ['disabled', 'mouse', 'scroll', 'key', 'dpi', 'media'],
    };
    if (profile.directory.rom) {
      notices.push({
        level: 'info',
        message: 'This mouse still runs its factory profiles. The first save copies them into its writable memory, like G HUB does.',
      });
    }
    if (mode === profiles.MODE_HOST) {
      notices.push({ level: 'warning', message: 'The mouse is in host mode (left there by G HUB). Saving switches it back to its onboard memory.' });
    }
  } else {
    notices.push({
      level: 'warning',
      message:
        'Changes are applied live and may reset when the mouse powers off' +
        (profileProblem ? `, because ${profileProblem}. Please send the debug report so we can add it.` : '.'),
    });
  }

  const buttonIdToIndex = new Map((capabilities.buttons?.buttons ?? []).map((b, i) => [b.id, i]));

  async function refreshProfile(): Promise<void> {
    if (!profile) return;
    profile.sector = await profiles.getCurrentProfile(mouse);
    profile.bytes = await profiles.readSector(mouse, profile.sector, profile.info.sectorSize);
  }

  /**
   * Make sure the active profile lives in flash. Factory profiles sit in ROM,
   * so copy every profile into flash sectors 1..n and point sector 0 at them.
   */
  async function ensureWritable(p: ProfileState): Promise<number> {
    if (!p.directory.rom && p.sector < p.info.sectorCount) return p.sector;
    if (!p.directory.rom) throw new Error(`Profile sector 0x${p.sector.toString(16)} is read-only.`);
    const entries = p.directory.entries;
    if (entries.length + 1 > p.info.sectorCount) throw new Error('Not enough writable memory to copy the factory profiles.');
    const copies: profiles.ProfileEntry[] = [];
    for (const [i, e] of entries.entries()) {
      const target = i + 1;
      const bytes = e.sector === p.sector ? p.bytes : await profiles.readSector(mouse, e.sector, p.info.sectorSize);
      await profiles.writeSector(mouse, target, profiles.sealSector(new Uint8Array(bytes)));
      copies.push({ sector: target, enabled: e.enabled });
    }
    await profiles.writeSector(mouse, 0, profiles.buildDirectory(copies, p.info.sectorSize));
    const active = entries.findIndex((e) => e.sector === p.sector) + 1;
    p.directory = { rom: false, entries: copies };
    p.sector = active;
    return active;
  }

  return {
    info,
    capabilities,
    notices,

    async read() {
      const settings: MouseSettings = {};
      const sensor = dpiInfo ? await hidpp.getSensorDpi(mouse, dpiInfo) : undefined;

      if (profile) {
        await refreshProfile();
        const dpis = profiles.profileDpis(profile.bytes);
        if (dpis.length && capabilities.dpi) {
          let active: number | undefined;
          try {
            active = await profiles.getCurrentDpiIndex(mouse);
          } catch {
            active = sensor ? dpis.indexOf(sensor.x) : undefined;
          }
          if (active === undefined || active < 0 || active >= dpis.length) active = Math.min(profiles.profileDefaultDpiIndex(profile.bytes), dpis.length - 1);
          settings.dpi = { stages: dpis.map((x) => ({ x })), active };
        }
        const rate = profiles.profileReportRate(profile.bytes);
        if (rate !== undefined && capabilities.pollingRate?.rates.includes(rate)) settings.pollingRate = rate;
        settings.buttons = {};
        for (const [id, i] of buttonIdToIndex) {
          settings.buttons[id] = profiles.decodeButton(profiles.profileButton(profile.bytes, i), profiles.factoryButton(i));
        }
      } else {
        if (sensor && capabilities.dpi) settings.dpi = { stages: [sensor.y !== sensor.x ? { x: sensor.x, y: sensor.y } : { x: sensor.x }], active: 0 };
        if (rateInfo) settings.pollingRate = await hidpp.getReportRate(mouse, rateInfo);
      }
      if (capabilities.lod) settings.lod = lodName(sensor?.lod) ?? 'medium';

      const battery = await hidpp.getBattery(mouse).catch(() => undefined);
      info.battery = battery;
      return settings;
    },

    async write(changes) {
      if (profile && (changes.dpi || changes.pollingRate !== undefined || changes.buttons)) {
        const bytes = new Uint8Array(profile.bytes);
        if (changes.dpi) {
          const dpis = changes.dpi.stages.map((s) => nearest(dpiValues, s.x));
          profiles.setProfileDpis(bytes, dpis, changes.dpi.active);
        }
        if (changes.pollingRate !== undefined) profiles.setProfileReportRate(bytes, changes.pollingRate);
        for (const [id, action] of Object.entries(changes.buttons ?? {})) {
          const i = buttonIdToIndex.get(id);
          if (i === undefined) continue;
          profiles.setProfileButton(bytes, i, profiles.encodeButton(action as ButtonAction, profiles.factoryButton(i), buttonFallback[i]!));
        }
        profiles.sealSector(bytes);

        const sector = await ensureWritable(profile);
        await profiles.writeSector(mouse, sector, bytes);
        const check = await profiles.readSector(mouse, sector, profile.info.sectorSize);
        if (!check.every((b, i) => b === bytes[i])) throw new Error('The mouse did not store the profile as written. Nothing else was changed.');
        if (mode !== profiles.MODE_ONBOARD) {
          await profiles.setMode(mouse, profiles.MODE_ONBOARD);
          mode = profiles.MODE_ONBOARD;
        }
        // Re-selecting the profile makes the mouse load what we just wrote.
        await profiles.setCurrentProfile(mouse, sector);
        if (changes.dpi) await profiles.setCurrentDpiIndex(mouse, changes.dpi.active).catch(() => undefined);
        profile.bytes = check;
        profile.sector = sector;
      } else {
        if (changes.dpi && dpiInfo) {
          const stage = changes.dpi.stages[changes.dpi.active]!;
          const current = await hidpp.getSensorDpi(mouse, dpiInfo);
          const x = nearest(dpiValues, stage.x);
          await hidpp.setSensorDpi(mouse, dpiInfo, { x, y: nearest(dpiValues, stage.y ?? stage.x), lod: current.lod });
        }
        if (changes.pollingRate !== undefined && rateInfo) await hidpp.setReportRate(mouse, rateInfo, changes.pollingRate);
      }
      if (changes.lod !== undefined && dpiInfo) {
        const current = await hidpp.getSensorDpi(mouse, dpiInfo);
        await hidpp.setSensorDpi(mouse, dpiInfo, { ...current, lod: lodValue(changes.lod) });
      }
    },

    async refreshInfo() {
      info.battery = await hidpp.getBattery(mouse).catch(() => undefined);
      return info;
    },

    async diagnostics() {
      const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return {
        deviceIndex: `0x${mouse.index.toString(16)}`,
        protocol: `${version.major}.${version.minor}`,
        probes,
        features: await mouse.listFeatures().catch((e: unknown) => String(e)),
        dpi: dpiInfo && { feature: dpiInfo.feature.toString(16), min: dpiValues[0], max: dpiValues.at(-1), count: dpiValues.length, perAxis: dpiInfo.perAxis, lod: dpiInfo.lod },
        reportRate: rateInfo && { feature: rateInfo.feature.toString(16), rates: rateInfo.rates },
        onboardProfiles: profilesInfo && {
          ...profilesInfo,
          mode,
          usable: Boolean(profile),
          problem: profileProblem,
          directory: profile?.directory,
          activeSector: profile?.sector,
          activeProfile: profile && toHex(profile.bytes),
        },
      };
    },

    close: () => mouse.transport.close(),
  };
}
