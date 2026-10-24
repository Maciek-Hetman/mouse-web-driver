// Core model shared by every driver and the UI.
//
// A driver translates between this vendor-neutral model and one wire protocol
// (Razer feature reports, Logitech HID++ 2.0, Endgame Gear vendor reports...).
// The UI only ever sees these types, so it renders whatever a driver declares
// in its Capabilities and never needs to know which protocol is underneath.

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type MouseButton = 'left' | 'right' | 'middle' | 'back' | 'forward';
export type KeyModifier = 'ctrl' | 'shift' | 'alt' | 'meta';

/** What a physical button does. Drivers advertise which kinds they can encode. */
export type ButtonAction =
  /** The factory function of this button. */
  | { kind: 'default' }
  | { kind: 'disabled' }
  | { kind: 'mouse'; button: MouseButton }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' }
  /** `code` is a KeyboardEvent.code value such as "KeyA" or "F13". */
  | { kind: 'key'; code: string; modifiers?: KeyModifier[] }
  | { kind: 'dpi'; action: DpiButtonAction }
  | { kind: 'media'; action: MediaAction };

export type ButtonActionKind = ButtonAction['kind'];
export type DpiButtonAction = 'cycle-up' | 'cycle-down' | 'cycle' | 'shift';
export type MediaAction = 'play-pause' | 'next' | 'previous' | 'volume-up' | 'volume-down' | 'mute';

/** One DPI stage. `y` is only set when the device supports separate X/Y DPI and it differs from `x`. */
export interface DpiStage {
  x: number;
  y?: number;
}

export interface DpiSettings {
  stages: DpiStage[];
  /** Index into `stages` of the stage the mouse is currently using. */
  active: number;
}

export type ExtraValue = boolean | number | string;

/**
 * A full or partial snapshot of the mouse's configuration.
 * `read()` returns every section the driver supports; `write()` receives only
 * the sections (and, for `buttons`/`extras`, only the keys) that changed.
 */
export interface MouseSettings {
  dpi?: DpiSettings;
  /** Report rate in Hz. */
  pollingRate?: number;
  /** One of `capabilities.lod.options[].value`. */
  lod?: string;
  /** Keyed by `capabilities.buttons.buttons[].id`. */
  buttons?: Record<string, ButtonAction>;
  /** Keyed by `capabilities.extras[].id`. */
  extras?: Record<string, ExtraValue>;
}

// ---------------------------------------------------------------------------
// Capabilities: what the connected mouse supports, which drives the UI
// ---------------------------------------------------------------------------

export interface Choice<T extends string | number = string> {
  value: T;
  label: string;
  description?: string;
}

export interface DpiCapability {
  min: number;
  max: number;
  step: number;
  /** Maximum number of stages the device stores. */
  maxStages: number;
  /** Minimum number of stages (most mice need at least one). Defaults to 1. */
  minStages?: number;
  /** Device accepts different X and Y DPI per stage. */
  perAxis: boolean;
}

export interface PollingRateCapability {
  /** Supported rates in Hz, ascending. */
  rates: number[];
}

export interface LodCapability {
  options: Choice[];
}

export interface ButtonInfo {
  id: string;
  label: string;
  /** False for buttons the device reports but refuses to remap (e.g. left click on some mice). */
  remappable?: boolean;
}

export interface ButtonCapability {
  buttons: ButtonInfo[];
  /** Action kinds this device can encode. 'default' is always implied. */
  actions: ButtonActionKind[];
}

interface ExtraSettingBase {
  id: string;
  label: string;
  description?: string;
  /** Optional heading the UI groups settings under, e.g. "Sensor" or "Power". */
  group?: string;
}

/** Device-specific settings (motion sync, angle snapping, debounce, sleep timer...). */
export type ExtraSetting =
  | (ExtraSettingBase & { type: 'toggle' })
  | (ExtraSettingBase & { type: 'select'; options: Choice[] })
  | (ExtraSettingBase & { type: 'range'; min: number; max: number; step: number; unit?: string });

export interface Capabilities {
  dpi?: DpiCapability;
  pollingRate?: PollingRateCapability;
  lod?: LodCapability;
  buttons?: ButtonCapability;
  extras?: ExtraSetting[];
}

// ---------------------------------------------------------------------------
// Device and driver
// ---------------------------------------------------------------------------

export type Platform = 'windows' | 'macos' | 'linux' | 'chromeos' | 'android' | 'unknown';

export interface Notice {
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface DeviceInfo {
  /** Marketing name, e.g. "DeathAdder V3". */
  name: string;
  vendor: string;
  firmware?: string;
  serial?: string;
  connection?: 'wired' | 'wireless' | 'receiver' | 'bluetooth';
  battery?: { percent?: number; charging?: boolean };
}

/** An open connection to one mouse. Created by `MouseDriver.open()`. */
export interface MouseSession {
  readonly info: DeviceInfo;
  readonly capabilities: Capabilities;
  /** Things the user should know about this device on this platform. */
  readonly notices?: Notice[];
  /** Read every supported setting from the device. */
  read(): Promise<MouseSettings>;
  /** Write the given changes. Only changed sections/keys are passed. */
  write(changes: MouseSettings): Promise<void>;
  /** Re-read volatile info such as battery level. */
  refreshInfo?(): Promise<DeviceInfo>;
  close(): Promise<void>;
}

export interface DriverContext {
  platform: Platform;
}

/**
 * One file in src/drivers/ default-exports one of these.
 *
 * A physical mouse usually shows up as several HIDDevice objects (one per USB
 * interface). `filters` decides what the browser's chooser offers, and
 * `matches` picks the interface that carries the control protocol:
 *   - Razer: the plain Mouse collection (usage page 0x01, usage 0x02), feature reports
 *   - Logitech HID++: vendor collection on usage page 0xFF00
 *   - Endgame Gear: vendor collection on usage page 0xFF01
 */
export interface MouseDriver {
  /** Stable id, e.g. "razer". */
  id: string;
  /** Human-readable driver name, e.g. "Razer (feature reports)". */
  name: string;
  /** Filters passed to navigator.hid.requestDevice(). */
  filters: HIDDeviceFilter[];
  /**
   * Whether this driver can control this HIDDevice. Defaults to "some filter
   * matches the device and one of its collections".
   */
  matches?(device: HIDDevice): boolean;
  /** Platform-specific caveats, shown before and after connecting. */
  platformNotes?(ctx: DriverContext): Notice[];
  open(device: HIDDevice, ctx: DriverContext): Promise<MouseSession>;
}
