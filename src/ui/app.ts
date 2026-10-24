import { DeviceAccessError, InterfaceMismatchError } from '../core/errors';
import { detectPlatform, webHidSupport, type WebHidSupport } from '../core/platform';
import type { DriverRegistry } from '../core/registry';
import { cloneSettings, diffSettings, isEmpty, validateSettings } from '../core/settings';
import type { DriverContext, MouseSession, MouseSettings, Notice } from '../core/types';
import { createMockSession } from '../mock/mock-mouse';
import { buttonsEditor, dpiEditor, extrasSections, lodEditor, pollingEditor, section, type EditorHooks } from './controls';
import { buildReport, copyButton, diagnosticsView } from './diagnostics';
import { h, hex } from './dom';

interface Connected {
  view: 'device';
  session: MouseSession;
  driverName: string;
  /** Null for the demo mouse. */
  device: HIDDevice | null;
  /** Last settings read back from the device. */
  saved: MouseSettings;
  /** What the user is editing. */
  draft: MouseSettings;
  busy: boolean;
  status: Notice | null;
}

type State =
  | { view: 'home'; granted: HIDDevice[][] }
  | { view: 'busy'; message: string }
  | { view: 'diagnostics'; devices: HIDDevice[]; error?: string; driver?: string }
  | Connected;

export class App {
  private state: State = { view: 'home', granted: [] };
  private banner: Notice | null = null;
  private footer: HTMLElement | null = null;
  private readonly ctx: DriverContext = { platform: detectPlatform() };
  private readonly support: WebHidSupport = webHidSupport();

  constructor(
    private readonly root: HTMLElement,
    private readonly registry: DriverRegistry,
  ) {}

  start(): void {
    if (this.support.ok) {
      navigator.hid.addEventListener('disconnect', (e) => this.onDisconnect(e.device));
      navigator.hid.addEventListener('connect', () => this.loadGranted());
      void this.loadGranted();
    }
    window.addEventListener('beforeunload', (e) => {
      if (this.dirtyCount() > 0) e.preventDefault();
    });
    this.render();
  }

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------

  /** Devices this origin was already allowed to use, grouped per physical mouse. */
  private async loadGranted(): Promise<void> {
    const devices = await navigator.hid.getDevices();
    const groups = new Map<string, HIDDevice[]>();
    for (const d of devices) {
      if (!this.registry.find(d)) continue;
      const key = `${d.vendorId}:${d.productId}:${d.productName}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    if (this.state.view === 'home') {
      this.state = { view: 'home', granted: [...groups.values()] };
      this.render();
    }
  }

  private async choose(anyDevice: boolean): Promise<void> {
    this.banner = null;
    let devices: HIDDevice[];
    try {
      devices = await navigator.hid.requestDevice({ filters: anyDevice ? [] : this.registry.requestFilters() });
    } catch (err) {
      this.fail(err);
      return;
    }
    if (devices.length > 0) await this.open(devices);
  }

  private async open(devices: HIDDevice[]): Promise<void> {
    const all = this.registry.candidates(devices);
    if (all.length === 0) {
      this.setState({ view: 'diagnostics', devices });
      return;
    }
    // One mouse can show up as several interfaces. Try each one the driver
    // claims until one answers; remember why the others didn't.
    const driver = all[0]!.driver;
    const candidates = all.filter((c) => c.driver === driver);
    let blocked: unknown;
    let mismatch: unknown;
    for (const [i, { device }] of candidates.entries()) {
      const which = candidates.length > 1 ? ` (interface ${i + 1} of ${candidates.length})` : '';
      this.setState({ view: 'busy', message: `Connecting to ${device.productName || driver.name}${which}…` });
      try {
        const session = await driver.open(device, this.ctx);
        await this.attach(session, driver.name, device);
        return;
      } catch (err) {
        if (device.opened) await device.close().catch(() => undefined);
        if (err instanceof DeviceAccessError) blocked ??= err;
        else if (err instanceof InterfaceMismatchError) mismatch = err;
        else return this.failWithReport(devices, driver.name, err);
      }
    }
    this.failWithReport(devices, driver.name, blocked ?? mismatch);
  }

  private failWithReport(devices: HIDDevice[], driver: string, err: unknown): void {
    this.banner = null;
    this.setState({ view: 'diagnostics', devices, driver, error: errorMessage(err) });
  }

  private async openDemo(): Promise<void> {
    this.banner = null;
    this.setState({ view: 'busy', message: 'Starting the demo mouse…' });
    await this.attach(createMockSession(), 'Demo driver', null);
  }

  private async attach(session: MouseSession, driverName: string, device: HIDDevice | null): Promise<void> {
    this.setState({ view: 'busy', message: `Reading settings from ${session.info.name}…` });
    const saved = await session.read();
    this.setState({
      view: 'device',
      session,
      driverName,
      device,
      saved,
      draft: cloneSettings(saved),
      busy: false,
      status: null,
    });
  }

  private async disconnect(): Promise<void> {
    if (this.state.view === 'device') await this.state.session.close().catch(() => undefined);
    this.goHome();
  }

  private onDisconnect(device: HIDDevice): void {
    if (this.state.view === 'device' && this.state.device === device) {
      this.banner = { level: 'warning', message: `${this.state.session.info.name} was unplugged or switched off.` };
      this.goHome();
    } else {
      void this.loadGranted();
    }
  }

  private goHome(): void {
    this.setState({ view: 'home', granted: [] });
    if (this.support.ok) void this.loadGranted();
  }

  private async apply(): Promise<void> {
    const s = this.state;
    if (s.view !== 'device' || s.busy) return;
    const changes = diffSettings(s.saved, s.draft);
    if (isEmpty(changes)) return;
    const errors = validateSettings(changes, s.session.capabilities);
    if (errors.length > 0) {
      s.status = { level: 'error', message: errors.join(' ') };
      this.renderFooter();
      return;
    }
    s.busy = true;
    s.status = { level: 'info', message: 'Writing to the mouse…' };
    this.render();
    try {
      await s.session.write(changes);
      // Read back so the UI shows what the device actually stored.
      s.saved = await s.session.read();
      s.draft = cloneSettings(s.saved);
      s.status = { level: 'info', message: 'Saved to the mouse.' };
    } catch (err) {
      s.status = { level: 'error', message: `Write failed: ${errorMessage(err)}` };
    } finally {
      s.busy = false;
      if (this.state === s) this.render();
    }
  }

  private revert(): void {
    if (this.state.view !== 'device') return;
    this.state.draft = cloneSettings(this.state.saved);
    this.state.status = null;
    this.render();
  }

  private fail(err: unknown): void {
    // The user closing the chooser is not an error.
    if (err instanceof DOMException && err.name === 'NotFoundError') return;
    this.banner = { level: 'error', message: errorMessage(err) };
    this.goHome();
  }

  private setState(state: State): void {
    this.state = state;
    this.render();
  }

  private dirtyCount(): number {
    if (this.state.view !== 'device') return 0;
    const d = diffSettings(this.state.saved, this.state.draft);
    return (
      (d.dpi ? 1 : 0) +
      (d.pollingRate !== undefined ? 1 : 0) +
      (d.lod !== undefined ? 1 : 0) +
      Object.keys(d.buttons ?? {}).length +
      Object.keys(d.extras ?? {}).length
    );
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    this.footer = null;
    const main = h('main', null, this.bannerView(), this.viewFor(this.state));
    this.root.replaceChildren(this.headerView(), main);
    if (this.footer) this.root.append(this.footer);
  }

  private headerView(): HTMLElement {
    return h(
      'header',
      { class: 'top' },
      h('div', null, h('h1', null, 'Mouse Web Driver'), h('p', { class: 'muted' }, 'Configure your mouse from the browser. No install, no background service.')),
    );
  }

  private bannerView(): HTMLElement | null {
    const notices: Notice[] = [];
    if (!this.support.ok) notices.push({ level: 'error', message: this.support.reason });
    if (this.banner) notices.push(this.banner);
    return notices.length ? h('div', { class: 'notices' }, notices.map(noticeView)) : null;
  }

  private viewFor(state: State): HTMLElement {
    switch (state.view) {
      case 'home':
        return this.homeView(state.granted);
      case 'busy':
        return h('section', { class: 'card busy' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', null, state.message));
      case 'diagnostics':
        return diagnosticsView(state.devices, { platform: this.ctx.platform, error: state.error, driver: state.driver }, () => this.goHome());
      case 'device':
        return this.deviceView(state);
    }
  }

  private homeView(granted: HIDDevice[][]): HTMLElement {
    const ok = this.support.ok;
    const drivers = this.registry.all;
    const platformNotes = drivers.flatMap((d) => d.platformNotes?.(this.ctx) ?? []);

    return h(
      'div',
      { class: 'stack' },
      h(
        'section',
        { class: 'card hero' },
        h('h2', null, 'Connect a mouse'),
        h(
          'p',
          null,
          'Plug the mouse in (or its receiver) and pick it in the browser’s device list. If it shows up more than once, pick any entry.',
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'primary', disabled: !ok, onclick: () => this.choose(drivers.length === 0) }, 'Connect mouse'),
          h('button', { onclick: () => this.openDemo() }, 'Try the demo mouse'),
        ),
        granted.length
          ? h(
              'div',
              { class: 'granted' },
              h('h3', null, 'Previously connected'),
              h(
                'div',
                { class: 'row' },
                granted.map((group) => h('button', { onclick: () => this.open(group) }, group[0]!.productName || hex(group[0]!.productId))),
              ),
            )
          : null,
        platformNotes.length ? h('div', { class: 'notices' }, platformNotes.map(noticeView)) : null,
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Supported mice'),
        drivers.length
          ? h('ul', null, drivers.map((d) => h('li', null, d.name)))
          : h('p', { class: 'muted' }, 'No hardware drivers are bundled yet. The demo mouse shows what the editor can do.'),
        h(
          'p',
          { class: 'muted' },
          'Mouse not listed? ',
          h('button', { class: 'link', disabled: !ok, onclick: () => this.choose(true) }, 'Pick any HID device'),
          ' to see what the browser can read from it.',
        ),
      ),
    );
  }

  private deviceView(s: Connected): HTMLElement {
    const { info, capabilities: caps } = s.session;
    const hooks: EditorHooks = {
      draft: s.draft,
      disabled: s.busy,
      changed: () => {
        s.status = null;
        this.renderFooter();
      },
      rerender: () => this.render(),
    };

    const facts = [
      info.vendor,
      info.firmware ? `firmware ${info.firmware}` : null,
      info.connection,
      info.battery?.percent !== undefined ? `battery ${info.battery.percent}%${info.battery.charging ? ' (charging)' : ''}` : null,
      s.driverName,
    ].filter(Boolean);

    const performance = [
      caps.dpi ? dpiEditor(caps.dpi, hooks) : null,
      caps.pollingRate ? pollingEditor(caps.pollingRate, hooks) : null,
      caps.lod ? lodEditor(caps.lod, hooks) : null,
    ].filter((x): x is HTMLElement => x !== null);

    this.footer = h('footer', { class: 'actions' });
    this.renderFooter();

    return h(
      'div',
      { class: 'stack' },
      h(
        'section',
        { class: 'card device' },
        h('div', null, h('h2', null, info.name), h('p', { class: 'muted' }, facts.join(' · '))),
        h('button', { disabled: s.busy, onclick: () => this.disconnect() }, 'Disconnect'),
      ),
      s.session.notices?.length ? h('div', { class: 'notices' }, s.session.notices.map(noticeView)) : null,
      performance.length ? section('Performance', performance) : null,
      caps.buttons ? section('Buttons', buttonsEditor(caps.buttons, hooks)) : null,
      extrasSections(caps.extras ?? [], hooks),
      s.device ? this.debugView(s, s.device) : null,
    );
  }

  /** A copyable report of what the driver saw, for testing on hardware we don't have. */
  private debugView(s: Connected, device: HIDDevice): HTMLElement {
    const out = h('pre', { class: 'dump', hidden: true });
    const build = async () => {
      let protocol: unknown;
      try {
        protocol = await s.session.diagnostics?.();
      } catch (err) {
        protocol = `diagnostics failed: ${errorMessage(err)}`;
      }
      return buildReport([device], {
        platform: this.ctx.platform,
        driver: s.driverName,
        session: { info: s.session.info, capabilities: s.session.capabilities, saved: s.saved, protocol },
      });
    };
    return h(
      'details',
      { class: 'card debug' },
      h('summary', null, 'Debug report'),
      h('p', { class: 'muted' }, 'Protocol details and the last packets exchanged with the mouse. Paste this into an issue when something looks wrong.'),
      h(
        'div',
        { class: 'row' },
        copyButton('Copy debug report', build, (text) => {
          out.textContent = text;
          out.hidden = false;
        }),
      ),
      out,
    );
  }

  private renderFooter(): void {
    const s = this.state;
    if (!this.footer || s.view !== 'device') return;
    const count = this.dirtyCount();
    const message = s.status?.message ?? (count ? `${count} unsaved change${count === 1 ? '' : 's'}` : 'All changes saved');
    this.footer.replaceChildren(
      h('span', { class: `status ${s.status?.level ?? (count ? 'pending' : '')}`, role: 'status' }, message),
      h('button', { disabled: s.busy || count === 0, onclick: () => this.revert() }, 'Revert'),
      h('button', { class: 'primary', disabled: s.busy || count === 0, onclick: () => this.apply() }, s.busy ? 'Saving…' : 'Apply'),
    );
  }
}

function noticeView(n: Notice): HTMLElement {
  return h('div', { class: `notice ${n.level}`, role: n.level === 'error' ? 'alert' : 'note' }, n.message);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
