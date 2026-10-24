// Renders setting editors from Capabilities. Every function mutates `draft`
// in place and then calls `changed()` (value edits) or `rerender()` (edits
// that change which controls exist).

import { describeAction, keyLabel } from '../core/settings';
import type {
  ButtonAction,
  ButtonActionKind,
  ButtonCapability,
  Choice,
  DpiCapability,
  ExtraSetting,
  KeyModifier,
  LodCapability,
  MouseSettings,
  PollingRateCapability,
} from '../core/types';
import { h, type Child } from './dom';

export interface EditorHooks {
  draft: MouseSettings;
  disabled: boolean;
  changed(): void;
  rerender(): void;
}

let uid = 0;
const nextId = (prefix: string) => `${prefix}-${++uid}`;

export function section(title: string, ...body: Child[]): HTMLElement {
  return h('section', { class: 'card' }, h('h2', null, title), ...body);
}

export function select<T extends string | number>(
  options: Choice<T>[],
  value: T | undefined,
  onChange: (value: T) => void,
  props: Record<string, unknown> = {},
): HTMLSelectElement {
  const el = h(
    'select',
    {
      ...props,
      onchange: () => {
        const picked = options[el.selectedIndex];
        if (picked) onChange(picked.value);
      },
    },
    options.map((o) => h('option', { selected: o.value === value }, o.label)),
  );
  return el;
}

/** A row of radio-style buttons for small option sets (polling rate, LOD). */
function segmented<T extends string | number>(
  name: string,
  options: Choice<T>[],
  value: T | undefined,
  disabled: boolean,
  onChange: (value: T) => void,
): HTMLElement {
  const group = nextId(name);
  return h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': name },
    options.map((o) => {
      const id = nextId(name);
      return [
        h('input', {
          type: 'radio',
          id,
          name: group,
          checked: o.value === value,
          disabled,
          onchange: () => onChange(o.value),
        }),
        h('label', { for: id, title: o.description }, o.label),
      ];
    }),
  );
}

// ---------------------------------------------------------------------------
// DPI
// ---------------------------------------------------------------------------

export function dpiEditor(cap: DpiCapability, hooks: EditorHooks): HTMLElement {
  const dpi = (hooks.draft.dpi ??= { stages: [{ x: 800 }], active: 0 });
  const separate = dpi.stages.some((s) => s.y !== undefined);
  const minStages = cap.minStages ?? 1;

  const numberInput = (value: number | undefined, label: string, set: (v: number) => void) =>
    h('input', {
      type: 'number',
      class: 'dpi-input',
      min: String(cap.min),
      max: String(cap.max),
      step: String(cap.step),
      value: value === undefined || Number.isNaN(value) ? '' : String(value),
      'aria-label': label,
      disabled: hooks.disabled,
      oninput: (e: Event) => {
        set((e.target as HTMLInputElement).valueAsNumber);
        hooks.changed();
      },
    });

  const group = nextId('dpi-active');
  const rows = dpi.stages.map((stage, i) =>
    h(
      'tr',
      { class: i === dpi.active ? 'active' : '' },
      h(
        'td',
        null,
        h('input', {
          type: 'radio',
          name: group,
          checked: i === dpi.active,
          disabled: hooks.disabled,
          'aria-label': `Make stage ${i + 1} active`,
          onchange: () => {
            dpi.active = i;
            hooks.rerender();
          },
        }),
      ),
      h('td', { class: 'muted' }, String(i + 1)),
      h('td', null, numberInput(stage.x, `Stage ${i + 1} ${separate ? 'X ' : ''}DPI`, (v) => (stage.x = v))),
      separate ? h('td', null, numberInput(stage.y, `Stage ${i + 1} Y DPI`, (v) => (stage.y = v))) : null,
      h(
        'td',
        null,
        h(
          'button',
          {
            class: 'icon',
            title: 'Remove stage',
            'aria-label': `Remove stage ${i + 1}`,
            disabled: hooks.disabled || dpi.stages.length <= minStages,
            onclick: () => {
              dpi.stages.splice(i, 1);
              if (dpi.active >= dpi.stages.length) dpi.active = dpi.stages.length - 1;
              else if (dpi.active > i) dpi.active--;
              hooks.rerender();
            },
          },
          '✕',
        ),
      ),
    ),
  );

  return h(
    'div',
    { class: 'field' },
    h(
      'div',
      { class: 'field-head' },
      h('h3', null, 'DPI stages'),
      h('span', { class: 'muted' }, `${cap.min}–${cap.max}, steps of ${cap.step}`),
    ),
    h(
      'table',
      { class: 'dpi-table' },
      h(
        'thead',
        null,
        h('tr', null, h('th', null, 'Active'), h('th', null, '#'), h('th', null, separate ? 'X' : 'DPI'), separate ? h('th', null, 'Y') : null, h('th')),
      ),
      h('tbody', null, rows),
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          disabled: hooks.disabled || dpi.stages.length >= cap.maxStages,
          onclick: () => {
            const last = dpi.stages[dpi.stages.length - 1];
            const x = Math.min(cap.max, (last?.x ?? 400) * 2);
            dpi.stages.push(separate ? { x, y: x } : { x });
            hooks.rerender();
          },
        },
        '+ Add stage',
      ),
      cap.perAxis
        ? h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: separate,
              disabled: hooks.disabled,
              onchange: (e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                for (const s of dpi.stages) {
                  if (on) s.y = s.x;
                  else delete s.y;
                }
                hooks.rerender();
              },
            }),
            'Separate X/Y',
          )
        : null,
      h('span', { class: 'muted' }, `${dpi.stages.length} of ${cap.maxStages}`),
    ),
  );
}

// ---------------------------------------------------------------------------
// Polling rate and LOD
// ---------------------------------------------------------------------------

export function formatRate(hz: number): string {
  return hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
}

export function pollingEditor(cap: PollingRateCapability, hooks: EditorHooks): HTMLElement {
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-head' }, h('h3', null, 'Polling rate')),
    segmented(
      'Polling rate',
      cap.rates.map((r) => ({ value: r, label: formatRate(r) })),
      hooks.draft.pollingRate,
      hooks.disabled,
      (v) => {
        hooks.draft.pollingRate = v;
        hooks.changed();
      },
    ),
  );
}

export function lodEditor(cap: LodCapability, hooks: EditorHooks): HTMLElement {
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-head' }, h('h3', null, 'Lift-off distance')),
    segmented('Lift-off distance', cap.options, hooks.draft.lod, hooks.disabled, (v) => {
      hooks.draft.lod = v;
      hooks.changed();
    }),
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<ButtonActionKind, string> = {
  default: 'Default',
  disabled: 'Disabled',
  mouse: 'Mouse button',
  scroll: 'Scroll',
  key: 'Keyboard key',
  dpi: 'DPI',
  media: 'Media',
};

/** A sensible starting action when the user switches to a kind. */
function defaultActionFor(kind: ButtonActionKind): ButtonAction {
  switch (kind) {
    case 'default':
    case 'disabled':
      return { kind };
    case 'mouse':
      return { kind, button: 'left' };
    case 'scroll':
      return { kind, direction: 'up' };
    case 'key':
      return { kind, code: '' };
    case 'dpi':
      return { kind, action: 'cycle-up' };
    case 'media':
      return { kind, action: 'play-pause' };
  }
}

function actionDetail(action: ButtonAction, label: string, hooks: EditorHooks, set: (a: ButtonAction) => void): Child {
  const props = { disabled: hooks.disabled, 'aria-label': `${label} detail` };
  const done = (a: ButtonAction) => {
    set(a);
    hooks.changed();
  };
  switch (action.kind) {
    case 'mouse':
      return select(
        (['left', 'right', 'middle', 'back', 'forward'] as const).map((b) => ({ value: b, label: describeAction({ kind: 'mouse', button: b }) })),
        action.button,
        (button) => done({ kind: 'mouse', button }),
        props,
      );
    case 'scroll':
      return select(
        (['up', 'down', 'left', 'right'] as const).map((d) => ({ value: d, label: describeAction({ kind: 'scroll', direction: d }) })),
        action.direction,
        (direction) => done({ kind: 'scroll', direction }),
        props,
      );
    case 'dpi':
      return select(
        (['cycle-up', 'cycle-down', 'cycle', 'shift'] as const).map((a) => ({ value: a, label: describeAction({ kind: 'dpi', action: a }) })),
        action.action,
        (a) => done({ kind: 'dpi', action: a }),
        props,
      );
    case 'media':
      return select(
        (['play-pause', 'next', 'previous', 'volume-up', 'volume-down', 'mute'] as const).map((a) => ({
          value: a,
          label: describeAction({ kind: 'media', action: a }),
        })),
        action.action,
        (a) => done({ kind: 'media', action: a }),
        props,
      );
    case 'key':
      return keyCapture(action, hooks, (a) => {
        set(a);
        hooks.rerender();
      });
    default:
      return null;
  }
}

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/** Button that records the next key combination pressed while it has focus. */
function keyCapture(action: Extract<ButtonAction, { kind: 'key' }>, hooks: EditorHooks, set: (a: ButtonAction) => void): HTMLElement {
  const idle = action.code ? describeAction(action) : 'Click, then press a key';
  const el = h(
    'button',
    {
      class: 'key-capture',
      disabled: hooks.disabled,
      onclick: () => {
        el.textContent = 'Press a key…';
        el.classList.add('listening');
      },
      onblur: () => {
        el.textContent = idle;
        el.classList.remove('listening');
      },
      onkeydown: (e: KeyboardEvent) => {
        if (!el.classList.contains('listening')) return;
        e.preventDefault();
        if (MODIFIER_CODES.has(e.code)) {
          el.textContent = `${keyLabel(e.code)} + …`;
          return;
        }
        const modifiers: KeyModifier[] = [];
        if (e.ctrlKey) modifiers.push('ctrl');
        if (e.shiftKey) modifiers.push('shift');
        if (e.altKey) modifiers.push('alt');
        if (e.metaKey) modifiers.push('meta');
        set(modifiers.length ? { kind: 'key', code: e.code, modifiers } : { kind: 'key', code: e.code });
      },
    },
    idle,
  );
  return el;
}

export function buttonsEditor(cap: ButtonCapability, hooks: EditorHooks): HTMLElement {
  const buttons = (hooks.draft.buttons ??= {});
  const kinds: ButtonActionKind[] = ['default', ...cap.actions.filter((k) => k !== 'default')];

  const rows = cap.buttons.map((info) => {
    const action = buttons[info.id] ?? { kind: 'default' };
    const set = (a: ButtonAction) => (buttons[info.id] = a);
    const locked = info.remappable === false;
    return h(
      'tr',
      null,
      h('th', { scope: 'row' }, info.label),
      h(
        'td',
        null,
        locked
          ? h('span', { class: 'muted' }, 'Not remappable')
          : select(
              kinds.map((k) => ({ value: k, label: KIND_LABELS[k] })),
              action.kind,
              (kind) => {
                set(defaultActionFor(kind));
                hooks.rerender();
              },
              { disabled: hooks.disabled, 'aria-label': `${info.label} action` },
            ),
      ),
      h('td', null, locked ? null : actionDetail(action, info.label, hooks, set)),
    );
  });

  return h('table', { class: 'buttons-table' }, h('tbody', null, rows));
}

// ---------------------------------------------------------------------------
// Device-specific extras
// ---------------------------------------------------------------------------

function extraControl(def: ExtraSetting, hooks: EditorHooks): HTMLElement {
  const extras = (hooks.draft.extras ??= {});
  const id = nextId(def.id);
  const value = extras[def.id];
  const set = (v: boolean | number | string) => {
    extras[def.id] = v;
    hooks.changed();
  };

  let control: HTMLElement;
  switch (def.type) {
    case 'toggle':
      control = h('input', {
        type: 'checkbox',
        role: 'switch',
        class: 'switch',
        id,
        checked: value === true,
        disabled: hooks.disabled,
        onchange: (e: Event) => set((e.target as HTMLInputElement).checked),
      });
      break;
    case 'select':
      control = select(def.options, typeof value === 'string' ? value : undefined, set, { id, disabled: hooks.disabled });
      break;
    case 'range': {
      const output = h('output', { for: id }, `${String(value ?? def.min)}${def.unit ? ' ' + def.unit : ''}`);
      control = h(
        'span',
        { class: 'range' },
        h('input', {
          type: 'range',
          id,
          min: String(def.min),
          max: String(def.max),
          step: String(def.step),
          value: String(value ?? def.min),
          disabled: hooks.disabled,
          oninput: (e: Event) => {
            const v = (e.target as HTMLInputElement).valueAsNumber;
            output.textContent = `${v}${def.unit ? ' ' + def.unit : ''}`;
            set(v);
          },
        }),
        output,
      );
      break;
    }
  }

  return h(
    'div',
    { class: 'extra' },
    h('label', { for: id }, def.label, def.description ? h('small', null, def.description) : null),
    control,
  );
}

/** Extras grouped by `group`, in declaration order. */
export function extrasSections(defs: ExtraSetting[], hooks: EditorHooks): HTMLElement[] {
  const groups = new Map<string, ExtraSetting[]>();
  for (const def of defs) {
    const key = def.group ?? 'Other settings';
    groups.set(key, [...(groups.get(key) ?? []), def]);
  }
  return [...groups].map(([title, items]) => section(title, items.map((d) => extraControl(d, hooks))));
}
