# SYNQ: quick guide

Thanks for trying SYNQ 0.1.0. It is a small Windows app that puts your headphone EQ, your mouse, keyboard, controller, headset, monitor, webcam and RGB light settings in one place. This is the first release, so if anything feels rough, tell us (see "Sending feedback" at the end).

You need: Windows 10 or 11, 64-bit, and about 5 minutes. Installing asks for an administrator OK once.

---

## 1. Install

1. Download `SYNQ_0.1.0_x64-setup.exe` (about 49.5 MB). If your browser or chat app says the file "may be dangerous" or "isn't commonly downloaded", choose **Keep**. That is only because the app is new and unsigned.
2. (Optional) Check you got the right file. In PowerShell run `Get-FileHash .\SYNQ_0.1.0_x64-setup.exe` and compare it with this line:
   `95414e8b3f12f4d030fadb876a123f07119e54bc72174ea7db9ed4a9856de7ff`
3. Double-click the installer.
4. **Windows will show a blue box: "Windows protected your PC".** This is SmartScreen. It appears because the app isn't code-signed (we haven't bought a certificate yet), not because something was found in the file.
   - Click **More info**.
   - Click **Run anyway**.
5. Windows asks "Do you want to allow this app to make changes?" Click **Yes**. The installer needs this to install for all users and to set up the sound engine (next step).
6. Click through the installer. While it works you will see **"Setting up the EQ engine (Equalizer APO)..."**. This takes up to a minute, and your sound may cut out for a second or two while Windows restarts its audio service. That is normal.
   - If the PC already has Equalizer APO, the installer leaves it exactly as it is.
   - If it says Windows will finish loading the EQ engine after a restart, restart the PC once.
7. On the last page you can tick **Run SYNQ** and **Create desktop shortcut**. Later you can always open it from the Start menu.

On a very old Windows 10 that doesn't have Microsoft's WebView2 component, the installer downloads it first, so be online for that install. Windows 11 already has it.

Where things go: the program is in `C:\Program Files\SYNQ`, your own data (presets, backups, logs) is in `%APPDATA%\com.logan.onboard`. Nothing runs in the background when SYNQ is closed, and the app does not need the internet.

---

## 2. What SYNQ does

- **Sound.** An EQ for everything Windows plays through your current headphones or speakers. Move the bands, save presets, undo. It never saves an EQ that would be louder than the original sound, and it backs up your previous setting every time you change it. The EQ itself is done by Equalizer APO (free software by Jonas Thedering), which SYNQ installs and sets up for you, so you don't have to touch its own tools. You can give your headphones a name; that name is kept only on your PC.
- **Mouse.** Shows the mouse that is plugged in and lets you change DPI steps, polling rate and lift-off distance on mice it supports. Changes are written into the mouse itself, so they stay after a restart, and SYNQ saves a backup first and reads each change back to check it.
- **Keyboard.** Per-key settings on the keyboards it supports (see the next section for the X68 HE).
- **Controllers.** Any controller Windows sees shows up on the Devices page, with a tester: stick drift, how round each stick's range is, deadzones, trigger range, every button, and the real polling rate. Some pads also have their own settings (DualSense Edge profiles, GameSir Cyclone 2 / G7 Pro 8K / Tarantula Pro 8K, the original 8BitDo Ultimate, Flydigi Apex 4). Those settings have **never been tried on a real controller**, so they stay off until you turn on **Allow changes** for that pad, back the pad up first, and check every change.
- **Lights.** Govee lights over Bluetooth (no Govee app), Wi-Fi lights on your network (Hue, Nanoleaf, Elgato, Twinkly, WiZ, Yeelight, LIFX; press **Find lights**), Windows Dynamic Lighting devices and some USB RGB hubs, together in one Lights view. Only one Govee lamp model has been tried for real, so everything else is **Experimental**.
- **Headsets, monitors and webcams.** Battery and settings for 27 gaming headsets; brightness, contrast, colour and input for monitors that support DDC/CI; exposure, focus and the rest for webcams. All read-only until you turn on **Allow changes**, with a backup and **Put back**. **Find your headphones** on the Sound page finds an EQ preset for your headphone model.
- **Gear Doctor.** **Run checkup** on the Devices page checks your mouse, keyboard and controller in about a minute and explains anything odd in plain words.

It never touches firmware, pairing or factory reset on any device.

**Controller owners:** open your controller from the Devices page, go to **Test**, and move the sticks and press everything: that's the most useful thing you can send us (a screenshot of the Test and Polling tabs, and **Save diagnostics**). Close the maker's own app (GameSir Nexus, Steam, DS4Windows and the like) first; SYNQ warns you when one is open. Leave **Allow changes** off unless we've asked you to try it.

**Superlight 2 owners:** plug the mouse in (cable or its wireless receiver) and open the **Mouse** page. It should appear **by name** (PRO X SUPERLIGHT 2, read from the mouse itself). If it shows a generic name like "Logitech mouse", a different name, or nothing at all, that is exactly what we want to hear about: send a screenshot and say whether it was on the cable or the receiver.

---

## 3. First run for the MAGIC-REFINER X68 HE

SYNQ learned this keyboard's language from its maker's website, but it has **never been tried on a real X68 HE**. So the first run is look-only, and the one thing we need back from you is a report file. Please follow these steps in order:

1. **Close illumipc.** The keyboard can only talk to one program at a time. Close every browser tab or window that has illumipc.com open.
2. **Plug the keyboard in with its USB cable.** Not Bluetooth, not the wireless dongle.
3. **Open SYNQ and go to the Keyboard page.** It reads the keyboard; while it does you'll see "Reading the keyboard...". Nothing is changed during reading.
4. **Leave "Allow changes" OFF.** You'll see a card that says "Read-only until you allow changes" with a switch. Leave it as it is. Don't change any key settings yet.
5. **Press "Save diagnostics"** (the button at the top of the page, next to Reconnect). A message appears saying "Diagnostics saved" and where the file went. This only reads; nothing is sent to the keyboard to make the file.
6. **Send us the two files.** Press **Win + R**, paste `%APPDATA%\com.logan.onboard\keyboard` and press Enter. From that folder send:
   - `x68he-<something>-diag-<number>.json` (the diagnostics file; if you pressed the button twice, send the newest)
   - `x68he-<something>-hid-log.txt` (a log of everything the app asked the keyboard and what it answered)

   They contain your keyboard's model, serial number and settings as read, plus the names of the supported devices SYNQ saw on your PC. No personal files, passwords or browsing data.

If the page says "Plug it in", or "The keyboard didn't answer": close illumipc, unplug the keyboard, plug it back in and press **Reconnect**. If it still fails, send a screenshot.

We'll tell you after we've read the files whether it's safe to turn "Allow changes" on. Until then, please leave it off.

---

## 4. Undoing the EQ engine setup

Three steps, from lightest to most complete. You can stop at any of them.

1. **Undo what SYNQ set up on your sound output.** In SYNQ, open the **Sound** page, click the **"EQ engine: ..."** chip at the top, then **Undo the last engine change**. Windows asks permission once. This puts your sound output back exactly the way it was before and restarts Windows' audio service for a moment. If you don't see the Undo button, nothing was changed on your sound output.
2. **Remove the EQ engine itself.** Open Windows **Settings > Apps** (called "Installed apps" on Windows 11 and "Apps & features" on Windows 10), find **Equalizer APO**, and choose **Uninstall**. Restart the PC afterwards. (Do step 1 first if SYNQ is still installed.)
3. **Remove SYNQ.** In the same list, uninstall **SYNQ**. This does *not* remove Equalizer APO (step 2 does that). Your presets and backups in `%APPDATA%\com.logan.onboard` are kept unless you tick the "Delete the application data" box in the uninstaller; you can also delete that folder yourself.

If your sound ever sounds wrong, do step 1 first, then tell us what you heard.

Good to know: don't use Equalizer APO's own "Configuration Editor" window while SYNQ is open. Both edit the same file, and the editor can quietly overwrite what SYNQ saved. SYNQ warns you if it sees the editor open.

---

## 5. Sending feedback

Open an issue at [github.com/logan-wurx/synqhub/issues](https://github.com/logan-wurx/synqhub/issues) (a security problem: use the repository's private reporting instead, see SECURITY.md). The more of these you can include, the faster we can fix it:

- What you did, what you expected, what happened instead (a sentence each is plenty).
- Which device: mouse or keyboard model, and cable or wireless.
- A screenshot (**Win + Shift + S**, then paste it into the issue).
- Your Windows version (**Settings > System > About**) and the SYNQ version (in the Windows Apps list; it says 0.1.0).
- For anything that went wrong with a device or the sound, the data folder zipped up. Open PowerShell and run this; it puts `SYNQ-feedback.zip` on your desktop:

  ```
  Compress-Archive -Path "$env:APPDATA\com.logan.onboard" -DestinationPath "$env:USERPROFILE\Desktop\SYNQ-feedback.zip" -Force
  ```

  It holds your EQ presets and backups, the logs of what the app sent to your mouse and keyboard, and the name you gave your headphones. Have a look inside before you attach it to a public issue.

Good things to tell us too: anything confusing, anything that felt slow, anything you expected to find and couldn't.

Thanks again.
