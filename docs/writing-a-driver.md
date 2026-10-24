# Writing a driver

A driver is one file in `src/drivers/` that default-exports a `MouseDriver`
(see `src/core/types.ts`). `src/drivers/index.ts` picks up every file in that
folder automatically, so adding a mouse family needs no other edits.

```ts
// src/drivers/example.ts
import { HidTransport } from '../core/transport';
import type { MouseDriver } from '../core/types';

const driver: MouseDriver = {
  id: 'example',
  name: 'Example mice',
  // What the browser's chooser offers. Add usagePage/usage to target the control interface.
  filters: [{ vendorId: 0x1234, productId: 0x5678, usagePage: 0xff00 }],

  async open(device, ctx) {
    const t = new HidTransport(device);
    await t.open();
    return {
      info: { name: 'Example Mouse', vendor: 'Example' },
      capabilities: {
        dpi: { min: 100, max: 26000, step: 50, maxStages: 5, perAxis: false },
        pollingRate: { rates: [125, 250, 500, 1000] },
      },
      async read() {
        /* query the device, return MouseSettings */
        return {};
      },
      async write(changes) {
        /* only changed sections arrive here */
      },
      close: () => t.close(),
    };
  },
};

export default driver;
```

## The contract

- **`capabilities` drives the UI.** Declare only what the device can actually
  do. A section that is missing is simply not shown.
- **`read()` returns every section you declared**, with button ids and extra ids
  matching the capability lists.
- **`write(changes)` gets a diff.** Only changed sections arrive; `buttons` and
  `extras` contain only the changed keys. `dpi` always arrives whole (stages
  plus active index) because every protocol we target writes the table as one
  unit. The app validates against your capabilities first, and reads back
  after writing so the UI shows what the device stored.
- **One physical mouse, several `HIDDevice`s.** Each USB interface is its own
  `HIDDevice`. Use `usagePage`/`usage` in `filters`, or a custom `matches()`,
  so the registry picks the interface that speaks your protocol.
- **Serialise exchanges.** Wrap every command/response pair in
  `transport.exclusive()` so overlapping UI actions can't interleave packets.
- **Platform caveats** go in `platformNotes(ctx)` (shown on the home screen) or
  in the session's `notices` (shown once connected).

## How the target protocols map onto it

| | Razer | Logitech HID++ 2.0 | Endgame Gear OP1 8k |
|---|---|---|---|
| Interface | Mouse collection, usage page `0x01` usage `0x02` | Vendor collection `0xFF00` (on the receiver for wireless) | Vendor collection `0xFF01` |
| Transport call | `sendFeature(0, packet)` then `receiveFeature(0)` inside `exclusive()` | `request(() => sendReport(0x10 or 0x11, …), match)`; match on device index + feature index + function/sw id | `sendFeature(0xA1, cmd)` then `receiveFeature(0xA0)` |
| Packet | 90 bytes, transaction id `0x1F`, CRC | 7 or 20 bytes; features resolved via root feature `0x0000` | 64-byte commands, 1041-byte config blob |
| Notes | Windows Chrome blocks this interface (see `platformNotes`) | Look up feature indexes once in `open()` | Read/modify/write the whole blob in `write()` |

Protocol details for the five test mice are in the project's research report.

## Testing without hardware

`tests/fake-hid.ts` is a scriptable `HIDDevice`. Give it an `onFeature` or
`onOutput` handler that answers like the real mouse (replaying bytes from a USB
capture works well) and drive your session against it. See
`tests/transport.test.ts` for both request styles.
