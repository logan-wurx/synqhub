## New in beta 5

- **Gear Doctor.** **Run checkup** on the Devices page: about 50 seconds of guided steps for every connected mouse,
  keyboard, controller and the sound output (click chatter, real polling rate, dropouts and sensor jumps, stuck or
  chattering keys, stick drift and circularity, EQ sanity), then a report card per device in plain words. **Fix it**
  uses the device's own guarded settings (debounce, polling, rapid trigger) with a backup and **Undo**. It only listens
  while OnBoard is the window in front.
- **Pro setups.** Inside Keep your feel, collapsed: 41 CS2 and Valorant pros (source and date for each). Their DPI,
  polling and in-game sensitivity translated to your mouse, side by side with yours; **Apply** and **Undo**.
- **Lights.** Your Govee lamps over Bluetooth with no Govee app: colour, white, brightness, painting segment by segment
  on a drawing shaped like the real light, gradients, the lamp's own scenes with moving previews, DIY effects, music mode
  and screen sync (about 1 ms of CPU a second, off by default, an obvious Stop). 85 Govee models, Philips Hue, Nanoleaf,
  Elgato, Twinkly, WiZ, Yeelight and LIFX on your home network (found only when you press Find lights; no accounts, no
  cloud), Windows Dynamic Lighting devices, and USB RGB hubs (NZXT HUE 2, Corsair Lighting Node family, Lian Li Uni Hub
  SL). Only the H6076 floor lamp has been tried on real hardware; everything else says Experimental. Nothing ASUS is ever
  listed or touched.
- **Headphones and headsets.** **Find your headphones** on the Sound page: about 6,000 models from AutoEq, fetched from
  GitHub only when you open it, saved as a preset or used now (with a backup). 27 gaming headsets (SteelSeries Arctis Nova
  7 family, Logitech G535 / PRO X / G733 / G935 families, HyperX Cloud II Wireless): battery, chat-mix and their settings
  behind **Allow changes**.
- **Monitors and webcams.** Monitors over DDC/CI (brightness, contrast, colour preset and balance, volume, input with a
  15-second "keep it?"), webcams over UVC (exposure, focus, zoom, white balance...), read-only until **Allow changes**,
  backed up first, **Put back**. Never a factory reset or a power command.
- **A tidier Devices page.** Cards grouped by type, a type filter once the list is long, "Keep your feel" only where it
  applies, the sidebar saying "N connected" instead of a cut-off list, device pages without a tab bar when they have one
  tab, and an amber (not red) note when the EQ clips. 640 official device pictures (from 527); everything else has a
  drawing of its own shape.
- **Lights and Displays tabs.** The sidebar is now Devices, Lights, Displays, Games, Settings: mice, keyboards, sound,
  controllers and webcams on Devices; every light on Lights; monitors on Displays. A lamp at the edge of Bluetooth reach
  no longer flickers between in range and weak.
- **Open source.** OnBoard is free software under the GNU AGPL 3.0 or later (LICENSE; Settings > About links to the code).
- **Website.** Works in a narrow browser window (the sidebar becomes icons).
- **Accessibility and idle cost.** Every page works from the keyboard (arrow keys in every choice row, a visible focus ring), text meets WCAG AA contrast, "reduce motion" is honoured, and on Windows the device list now updates from plug and unplug events instead of a timer (an idle Devices page measured at about 0.01 % CPU).
