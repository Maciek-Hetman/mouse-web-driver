# Mouse Web Driver

Configure gaming mice from the browser. DPI stages, polling rate, lift-off
distance, button remapping and per-mouse extras, over WebHID. No install and
no background service or bridge: it is a static page.

Works in desktop Chromium browsers (Chrome, Edge, Brave, Opera, Vivaldi) on
Linux, macOS and Windows. Firefox and Safari don't implement WebHID.

## Status

The app shell, driver interface and a demo mouse are in place. Hardware
drivers come next:

- [ ] Razer (DeathAdder V3, DeathAdder V3 HyperSpeed, Basilisk V3)
- [ ] Logitech HID++ 2.0 (G Pro X Superlight 2c)
- [ ] Endgame Gear (OP1 8k v2)

Until then, **Try the demo mouse** shows the full editor, and **Pick any HID
device** dumps what the browser can see from any device, which is the first
thing a new driver needs.

## Development

```sh
npm install
npm run dev        # http://localhost:5173 (localhost counts as a secure context)
npm test
npm run build      # static site in dist/
```

WebHID only works on `https://` or `localhost`. The `Deploy to Pages` workflow
publishes `main` to GitHub Pages once Pages is enabled with source
"GitHub Actions".

### Platform notes

- **Linux:** the browser needs read/write access to the `/dev/hidraw*` node.
  A udev rule like this (per vendor id) does it:
  `KERNEL=="hidraw*", ATTRS{idVendor}=="1532", TAG+="uaccess"`
- **macOS:** Chrome may ask for Input Monitoring permission for mouse
  interfaces.
- **Windows:** recent Chrome reportedly blocks feature reports on the standard
  mouse interface, which is what Razer mice use for configuration (not yet
  confirmed on our hardware). Logitech and Endgame Gear use vendor interfaces
  and are unaffected.

## Layout

```
src/core/types.ts      settings model, capabilities, MouseDriver / MouseSession
src/core/registry.ts   picks the driver and HID interface for a device
src/core/transport.ts  WebHID wrapper: feature reports, request/response, queueing
src/core/settings.ts   diffing and validation against capabilities
src/drivers/           one file per mouse family, auto-registered
src/mock/              in-memory demo mouse
src/ui/                the generic editor, rendered from capabilities
```

Adding a mouse: see [docs/writing-a-driver.md](docs/writing-a-driver.md).

## License

GPL-3.0. See [LICENSE](LICENSE).
