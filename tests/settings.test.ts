import { describe, expect, it } from 'vitest';
import { describeAction, diffSettings, isEmpty, keyLabel, validateSettings } from '../src/core/settings';
import type { MouseSettings } from '../src/core/types';
import { mockCapabilities as caps } from '../src/mock/mock-mouse';

const base: MouseSettings = {
  dpi: { stages: [{ x: 800 }, { x: 1600 }], active: 0 },
  pollingRate: 1000,
  lod: '1mm',
  buttons: { right: { kind: 'default' }, back: { kind: 'default' } },
  extras: { motionSync: true, debounce: 4 },
};

describe('diffSettings', () => {
  it('is empty when nothing changed', () => {
    expect(isEmpty(diffSettings(base, structuredClone(base)))).toBe(true);
  });

  it('returns only changed sections and keys', () => {
    const after = structuredClone(base);
    after.pollingRate = 4000;
    after.buttons!.back = { kind: 'key', code: 'F13' };
    after.extras!.debounce = 2;
    expect(diffSettings(base, after)).toEqual({
      pollingRate: 4000,
      buttons: { back: { kind: 'key', code: 'F13' } },
      extras: { debounce: 2 },
    });
  });

  it('sends the whole DPI table when any stage changes', () => {
    const after = structuredClone(base);
    after.dpi!.stages[1]!.x = 3200;
    expect(diffSettings(base, after).dpi).toEqual({ stages: [{ x: 800 }, { x: 3200 }], active: 0 });
  });

  it('treats a removed y as unchanged from no y', () => {
    const after = structuredClone(base);
    after.dpi!.stages[0] = { x: 800, y: undefined };
    expect(diffSettings(base, after).dpi).toBeUndefined();
  });
});

describe('validateSettings', () => {
  it('accepts valid settings', () => {
    expect(validateSettings(base, caps)).toEqual([]);
  });

  it('checks DPI range, step, stage count and active stage', () => {
    const errors = validateSettings(
      { dpi: { stages: [{ x: 50 }, { x: 825 }, { x: NaN }, { x: 800 }, { x: 800 }, { x: 800 }], active: 9 } },
      caps,
    );
    expect(errors.join('\n')).toMatch(/between 1 and 5 DPI stages/);
    expect(errors.join('\n')).toMatch(/Pick which DPI stage/);
    expect(errors.join('\n')).toMatch(/Stage 1: DPI must be between/);
    expect(errors.join('\n')).toMatch(/Stage 2: DPI must be a multiple of 50/);
    expect(errors.join('\n')).toMatch(/Stage 3: enter a number/);
  });

  it('rejects per-axis DPI when unsupported', () => {
    const noAxis = { ...caps, dpi: { ...caps.dpi!, perAxis: false } };
    expect(validateSettings({ dpi: { stages: [{ x: 800, y: 400 }], active: 0 } }, noAxis)).toContain(
      'Stage 1: separate X/Y DPI is not supported.',
    );
  });

  it('checks polling rate, LOD, buttons and extras against capabilities', () => {
    const errors = validateSettings(
      {
        pollingRate: 333,
        lod: '3mm',
        buttons: { left: { kind: 'disabled' }, nope: { kind: 'default' }, back: { kind: 'key', code: '' } },
        extras: { motionSync: 1, debounce: 99, sleep: 'forever' },
      },
      caps,
    );
    expect(errors).toEqual([
      'Polling rate 333 Hz is not supported.',
      'Unknown lift-off distance.',
      'Left button cannot be remapped.',
      'Unknown button "nope".',
      'Side back: press a key to assign.',
      'Motion sync: expected on/off.',
      'Button debounce: must be between 0 and 20.',
      'Sleep after: unknown option.',
    ]);
  });
});

describe('labels', () => {
  it('describes actions', () => {
    expect(describeAction({ kind: 'key', code: 'KeyC', modifiers: ['ctrl'] })).toBe('Ctrl + C');
    expect(describeAction({ kind: 'dpi', action: 'shift' })).toBe('DPI shift (sniper)');
    expect(keyLabel('ArrowUp')).toBe('Arrow up');
    expect(keyLabel('Digit7')).toBe('7');
  });
});
