import type { ButtonAction, Capabilities, MouseSettings } from './types';

export function cloneSettings(settings: MouseSettings): MouseSettings {
  return structuredClone(settings);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function diffRecord<T>(before: Record<string, T> = {}, after: Record<string, T> = {}): Record<string, T> | undefined {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(after)) {
    if (!deepEqual(before[key], value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * What a driver's write() should receive: only the sections that changed, and
 * for buttons/extras only the keys that changed. DPI is sent whole because
 * every protocol we target writes the stage table as one unit.
 */
export function diffSettings(before: MouseSettings, after: MouseSettings): MouseSettings {
  const out: MouseSettings = {};
  if (after.dpi && !deepEqual(before.dpi, after.dpi)) out.dpi = after.dpi;
  if (after.pollingRate !== undefined && after.pollingRate !== before.pollingRate) out.pollingRate = after.pollingRate;
  if (after.lod !== undefined && after.lod !== before.lod) out.lod = after.lod;
  const buttons = diffRecord(before.buttons, after.buttons);
  if (buttons) out.buttons = buttons;
  const extras = diffRecord(before.extras, after.extras);
  if (extras) out.extras = extras;
  return out;
}

export function isEmpty(settings: MouseSettings): boolean {
  return Object.values(settings).every((v) => v === undefined);
}

/** Problems that would stop `settings` from being written to a device with `caps`. Empty means valid. */
export function validateSettings(settings: MouseSettings, caps: Capabilities): string[] {
  const errors: string[] = [];

  if (settings.dpi) {
    const cap = caps.dpi;
    const { stages, active } = settings.dpi;
    if (!cap) {
      errors.push('This mouse does not support DPI changes.');
    } else {
      const minStages = cap.minStages ?? 1;
      if (stages.length < minStages || stages.length > cap.maxStages) {
        errors.push(`Use between ${minStages} and ${cap.maxStages} DPI stages.`);
      }
      if (!Number.isInteger(active) || active < 0 || active >= stages.length) {
        errors.push('Pick which DPI stage is active.');
      }
      stages.forEach((stage, i) => {
        const axes: [string, number | undefined][] = [['', stage.x]];
        if (stage.y !== undefined) {
          if (!cap.perAxis) errors.push(`Stage ${i + 1}: separate X/Y DPI is not supported.`);
          axes[0]![0] = ' X';
          axes.push([' Y', stage.y]);
        }
        for (const [axis, value] of axes) {
          if (value === undefined || !Number.isFinite(value)) {
            errors.push(`Stage ${i + 1}${axis}: enter a number.`);
          } else if (value < cap.min || value > cap.max) {
            errors.push(`Stage ${i + 1}${axis}: DPI must be between ${cap.min} and ${cap.max}.`);
          } else if ((value - cap.min) % cap.step !== 0) {
            errors.push(`Stage ${i + 1}${axis}: DPI must be a multiple of ${cap.step}.`);
          }
        }
      });
    }
  }

  if (settings.pollingRate !== undefined && !caps.pollingRate?.rates.includes(settings.pollingRate)) {
    errors.push(`Polling rate ${settings.pollingRate} Hz is not supported.`);
  }

  if (settings.lod !== undefined && !caps.lod?.options.some((o) => o.value === settings.lod)) {
    errors.push('Unknown lift-off distance.');
  }

  if (settings.buttons) {
    const cap = caps.buttons;
    for (const [id, action] of Object.entries(settings.buttons)) {
      const info = cap?.buttons.find((b) => b.id === id);
      if (!cap || !info) {
        errors.push(`Unknown button "${id}".`);
        continue;
      }
      if (action.kind !== 'default' && info.remappable === false) {
        errors.push(`${info.label} cannot be remapped.`);
      } else if (action.kind !== 'default' && !cap.actions.includes(action.kind)) {
        errors.push(`${info.label}: "${action.kind}" actions are not supported.`);
      } else if (action.kind === 'key' && !action.code) {
        errors.push(`${info.label}: press a key to assign.`);
      }
    }
  }

  if (settings.extras) {
    for (const [id, value] of Object.entries(settings.extras)) {
      const def = caps.extras?.find((e) => e.id === id);
      if (!def) {
        errors.push(`Unknown setting "${id}".`);
      } else if (def.type === 'toggle' && typeof value !== 'boolean') {
        errors.push(`${def.label}: expected on/off.`);
      } else if (def.type === 'select' && !def.options.some((o) => o.value === value)) {
        errors.push(`${def.label}: unknown option.`);
      } else if (def.type === 'range' && (typeof value !== 'number' || value < def.min || value > def.max)) {
        errors.push(`${def.label}: must be between ${def.min} and ${def.max}.`);
      }
    }
  }

  return errors;
}

export function describeAction(action: ButtonAction): string {
  switch (action.kind) {
    case 'default':
      return 'Default';
    case 'disabled':
      return 'Disabled';
    case 'mouse':
      return `${capitalize(action.button)} click`;
    case 'scroll':
      return `Scroll ${action.direction}`;
    case 'key':
      return [...(action.modifiers ?? []).map(capitalize), keyLabel(action.code)].join(' + ') || 'Key';
    case 'dpi':
      return { 'cycle-up': 'DPI up', 'cycle-down': 'DPI down', cycle: 'DPI cycle', shift: 'DPI shift (sniper)' }[action.action];
    case 'media':
      return {
        'play-pause': 'Play / pause',
        next: 'Next track',
        previous: 'Previous track',
        'volume-up': 'Volume up',
        'volume-down': 'Volume down',
        mute: 'Mute',
      }[action.action];
  }
}

/** "KeyA" -> "A", "Digit1" -> "1", "ArrowUp" -> "Arrow up". */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/ ([A-Z])/g, (_, c: string) => ` ${c.toLowerCase()}`);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
