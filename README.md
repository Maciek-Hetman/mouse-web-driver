# Mouse Web Driver

Configure gaming mice from the browser. DPI stages, polling rate, lift-off
distance, button remapping and per-mouse extras, over WebHID. No install and
no background service or bridge: it is a static page.

Works in desktop Chromium browsers (Chrome, Edge, Brave, Opera, Vivaldi) on
Linux, macOS and Windows. Firefox and Safari don't implement WebHID.

## Status

| Driver | DPI stages | Polling rate | Lift-off | Buttons | Extras |
|---|---|---|---|---|---|
| Razer DeathAdder V3, DA V3 HyperSpeed (cable or dongle), Basilisk V3 | yes | yes, up to 8000 Hz on DA V3 | not yet | not yet | sleep timer, Basilisk scroll wheel |
| Logitech HID++ 2.0 (G Pro X Superlight 2c), cable or Lightspeed | yes, in the onboard profile | yes (up to 1000 Hz in the profile) | yes, if the mouse offers it | yes | battery |
| Endgame Gear OP1 8k v2 | in progress | | | | |

None of this has been confirmed on real hardware yet; see
[docs/hardware-testing.md](docs/hardware-testing.md). **Try the demo mouse**
shows the full editor without hardware, **Pick any HID device** dumps what the
browser can see from any device, and every connected mouse has a **Debug
report** with the protocol details and recent packets.

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
  A udev rule per vendor id does it, for example in
  `/etc/udev/rules.d/70-mouse-web-driver.rules`:
  ```
  KERNEL=="hidraw*", ATTRS{idVendor}=="1532", TAG+="uaccess"
  KERNEL=="hidraw*", ATTRS{idVendor}=="046d", TAG+="uaccess"
  KERNEL=="hidraw*", ATTRS{idVendor}=="3367", TAG+="uaccess"
  ```
  then `sudo udevadm control --reload && sudo udevadm trigger` and replug.
- **macOS:** Chrome may ask for Input Monitoring permission for mouse
  interfaces.
- **Windows:** recent Chrome reportedly blocks feature reports on the standard
  mouse interface, which is what Razer mice use for configuration (not yet
  confirmed on our hardware). The Razer driver detects this and says so.
  Logitech and Endgame Gear use vendor interfaces and are unaffected.
- **Everywhere:** close Synapse, G HUB and other vendor software first; they
  hold the interface and answer in our place.

## Layout

```
src/core/types.ts      settings model, capabilities, MouseDriver / MouseSession
src/core/registry.ts   picks the driver and HID interface for a device
src/core/transport.ts  WebHID wrapper: feature reports, request/response, queueing
src/core/settings.ts   diffing and validation against capabilities
src/core/hid-usage.ts  KeyboardEvent.code <-> HID usage tables
src/drivers/           one file per mouse family, auto-registered
src/protocols/         wire protocols the drivers share (Razer, HID++ 2.0, onboard profiles)
src/mock/              in-memory demo mouse
src/ui/                the generic editor, rendered from capabilities
```

Adding a mouse: see [docs/writing-a-driver.md](docs/writing-a-driver.md).

## License

GPL-3.0. See [LICENSE](LICENSE).
