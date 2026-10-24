# Testing on hardware

The Razer and Logitech drivers were written against the published protocol
decodes and tested against simulated mice, not real ones. This is the checklist
for the first runs on real hardware.

## Setup

### Linux (do this first)

Chromium browsers can only open a mouse's `/dev/hidraw*` node if your user is
allowed to, and by default only root is. Without this rule, connecting fails
with "Failed to open the device". The app's start page has a **Copy setup commands**
button (under "Linux: Failed to open the device?") that copies exactly this; paste it
into a terminal once:

```sh
sudo tee /etc/udev/rules.d/70-mouse-web-driver.rules >/dev/null <<'RULES'
# Razer
KERNEL=="hidraw*", ATTRS{idVendor}=="1532", TAG+="uaccess"
# Logitech (mice and Lightspeed receivers)
KERNEL=="hidraw*", ATTRS{idVendor}=="046d", TAG+="uaccess"
# Endgame Gear
KERNEL=="hidraw*", ATTRS{idVendor}=="3367", TAG+="uaccess"
RULES
sudo udevadm control --reload && sudo udevadm trigger
```

Then unplug and replug each mouse and receiver. To check it worked:
`ls -l /dev/hidraw*` should show a `+` after the permissions (an ACL for your
user) on the mouse's nodes. If OpenRazer or Solaar run in the background, stop
them while testing.

Any Chromium-based browser with WebHID works (Chrome, Edge, Brave, Helium…).

### Run the app

```sh
npm install
npm run dev     # then open http://localhost:5173
```

- Quit Razer Synapse and Logitech G HUB on Windows/macOS. They hold the
  interface and can answer in our place.
- macOS: if the browser asks for Input Monitoring, allow it and restart the
  browser.

## For each mouse

1. **Connect mouse** and pick the mouse (any entry if it shows up several
   times).
2. If it **fails**, you land on a "Couldn't connect" screen. Press **Copy as
   JSON** and send that. Nothing more to do for this mouse.
3. If it **connects**, compare what the page shows with what Synapse / G HUB
   showed last time (DPI stages, active stage, polling rate).
4. Open **Debug report** at the bottom, press **Copy debug report**, and save
   the text. For Logitech this includes the raw onboard profile, which doubles
   as a backup.
5. Change one DPI stage and the polling rate, press **Apply**. The page reads
   the settings back afterwards; check they match what you set.
6. Unplug and replug (or switch the mouse off and on), connect again, and check
   the change stuck. Use the DPI button to cycle stages and check each one feels
   right.
7. Copy the debug report once more and send both reports, with a line on what
   worked and what didn't.

## What each report answers

| Mouse | Open question |
|---|---|
| DeathAdder V3, **Windows** (if you have a Windows machine handy) | Does Chrome block Razer's control interface? If you get the "Chrome on Windows refused" message, also open `chrome://device-log` and copy the lines next to the mouse. |
| DeathAdder V3, Linux or macOS | Does the extended (8000 Hz) polling command and its commit packet work? |
| DA V3 HyperSpeed, dongle | Which of the two look-alike interfaces answers, and is the reply delay enough? Try it on the cable too. |
| Basilisk V3 | Does the interface the browser offers answer (OpenRazer uses interface 3)? Which scroll-wheel settings show up? |
| Superlight 2c, cable and receiver | Feature list, onboard profile format, and whether the first save (which copies the factory profiles into flash) works. |

## If a Logitech save goes wrong

The first save copies the factory profiles into the mouse's writable memory, the
same thing G HUB does on first use. If the mouse behaves oddly afterwards, G HUB
can reset it (Settings → reset to default / onboard memory), and the debug
report from step 4 holds the original profile bytes.
