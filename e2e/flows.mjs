// The end-to-end scenarios, written once against a tiny driver interface so the same steps run in CI (WebdriverIO
// + tauri-driver + WebKitWebDriver, driving the real Linux app built with `npm run build:e2e`: the preview's sample
// devices, nothing real) and, for checking selectors, against the browser preview.
//
// The driver `t` has: waitFor(sel, { gone?, timeout? }), click(sel), type(sel, text), count(sel), attr(sel, name),
// rect(sel), shot(name), errors() (console errors recorded so far). A selector starting with "//" or "(" is XPath,
// anything else CSS. click and type find the element afresh each time (and again if it went stale).

const xq = (s) => (s.includes("'") ? `"${s}"` : `'${s}'`);
const heading = (level, text) => `//h${level}[normalize-space()=${xq(text)}]`;
const button = (text) => `//button[normalize-space()=${xq(text)}]`;
/** A button in the first-run welcome (a dialog over the page, which has buttons of its own). */
const welcomeButton = (text) => `//*[@role='dialog']//button[normalize-space()=${xq(text)}]`;
const card = (name) => `//button[@aria-label=${xq(`Open ${name}`)}]`;
// The dock at the bottom: its entries carry their label in a span (Settings's is for screen readers only).
const dock = (label) => `//nav[@aria-label='Sections']//button[.//span[normalize-space()=${xq(label)}]]`;
const tab = (label) => `//*[@role='tab'][normalize-space()=${xq(label)}]`;
// The Sound page stays mounted while another page is shown (in a "hidden" box), tabs and all: only the tabs of
// the page on screen count.
const NOT_HIDDEN = `not(ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' hidden ')])`;
const TABS = `//*[@role='tab'][${NOT_HIDDEN}]`;
/** An element of the page on screen whose whole text is `text`. */
const shown = (text) => `//*[normalize-space()=${xq(text)}][${NOT_HIDDEN}]`;
const allowSwitch = `//*[@role='switch'][@aria-label='Allow changes'][${NOT_HIDDEN}]`;
const radio = (label) => `//*[@role='radio'][starts-with(normalize-space(), ${xq(label)})][${NOT_HIDDEN}]`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits until `sel` is on screen and has stopped moving (the same box twice in a row, 150 ms apart): a popover or a
 * card that is still settling into place isn't clicked mid-move. */
async function settle(t, sel, timeout = 10_000) {
  await t.waitFor(sel, { timeout });
  const same = (a, b) => a && b && ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) < 0.5);
  let before = await t.rect(sel);
  for (const end = Date.now() + timeout; Date.now() < end; ) {
    await pause(150);
    const now = await t.rect(sel);
    if (same(before, now)) return;
    before = now;
  }
  throw new Error(`${sel} kept moving`);
}
/** A device page's tab, when the page has a tab bar (a narrow window shows Overview as a tab of its own). */
async function openTab(t, label) {
  for (let i = 0; i < 40 && !(await t.count(tab(label))); i++) await pause(250);
  if (await t.count(tab(label))) await t.click(tab(label));
}
/** A display in a screen sync tab's picker (the preview has two: src/lib/lighting/monitors.ts), `on` when chosen. */
const display = (name, on = false) => `//*[@data-testid='sync-monitor']//button${on ? "[@aria-checked='true']" : ""}[starts-with(normalize-space(), ${xq(name)})]`;

/**
 * Opens a device card: its Overview must show `content` (a title on it: the main controls live there, read through
 * the real driver code); then its second tab must take over from the first.
 */
async function openAndSwitchTabs(t, name, content, shotName) {
  await t.click(dock("Gear"));
  await t.click(card(name));
  await t.waitFor(shown(content), { timeout: 30_000 });
  await t.shot(shotName);
  await t.waitFor(TABS, { timeout: 30_000 });
  const n = await t.count(TABS);
  if (n < 2) throw new Error(`${name}: expected at least 2 tabs, found ${n}`);
  const second = `(${TABS})[2]`;
  await t.click(second);
  await t.waitFor(`(${TABS})[2][@aria-selected='true']`);
  if ((await t.attr(`(${TABS})[1]`, "aria-selected")) !== "false") throw new Error(`${name}: the first tab is still selected`);
}

export const scenarios = [
  {
    name: "opens with the first-run welcome and can be stepped through",
    run: async (t) => {
      await t.waitFor(heading(2, "Welcome to SYNQ"), { timeout: 60_000 });
      await t.shot("01-welcome");
      await t.click(welcomeButton("Next"));
      await t.waitFor(heading(2, "Turn on SYNQ Helper?"));
      await t.shot("02-welcome-helper");
      // The helper step is the last one: "Not now" leaves the helper off and closes the welcome.
      await t.click(welcomeButton("Not now"));
      await t.waitFor(heading(2, "Turn on SYNQ Helper?"), { gone: true });
    },
  },
  {
    name: "shows the Devices home with the sample devices",
    run: async (t) => {
      await t.waitFor(heading(1, "Your setup."));
      await t.waitFor(card("X1 V2 Air+"));
      await t.waitFor(card("Falchion Ace HFX"));
      await t.waitFor(card("Headphones"));
      await t.shot("03-devices-home");
    },
  },
  {
    name: "offers the Linux device rule on the Devices home",
    linuxOnly: true,
    run: async (t) => {
      await t.waitFor("[data-testid='device-access']");
      await t.waitFor(button("Install the rule"));
      await t.shot("04-device-access");
    },
  },
  {
    name: "opens a mouse and switches its tabs",
    // "Pointer speed" heads the mouse console in every layout ("DPI steps" only shows on mice without the fader).
    run: (t) => openAndSwitchTabs(t, "X1 V2 Air+", "Pointer speed", "05-mouse-tab"),
  },
  {
    name: "opens a keyboard and switches its tabs",
    run: (t) => openAndSwitchTabs(t, "Falchion Ace HFX", "Actuation, key by key", "06-keyboard-tab"),
  },
  {
    name: "shows the Sound page and its EQ engine",
    run: async (t, { linux }) => {
      await t.click(dock("Gear"));
      await t.click(card("Headphones"));
      await t.waitFor(heading(1, "Headphones"));
      await t.shot("07-sound");
      await t.click(tab("Engine"));
      await t.waitFor(heading(3, "EQ engine"));
      // Linux: the engine is PipeWire's, and the panel says so.
      if (linux) await t.waitFor(`//*[contains(normalize-space(), 'It runs inside PipeWire')]`);
      await t.shot("08-sound-engine");
    },
  },
  {
    name: "shows Settings with the SYNQ Helper card",
    run: async (t, { linux }) => {
      await t.click(dock("Settings"));
      await t.waitFor(heading(1, "Settings"));
      await t.waitFor(`//*[@role='switch'][@aria-label='Run SYNQ Helper']`);
      if (linux) await t.waitFor(`//*[normalize-space()='Starts at login']`);
      await t.shot("09-settings");
    },
  },
  {
    name: "opens a controller and runs the tester",
    run: async (t) => {
      await t.click(dock("Gear"));
      // The sample DualSense (simulated: src/lib/controllers/sim.ts), the G7 SE through XInput, a Switch Pro, and an
      // 8BitDo receiver whose pad is off (greyed, last).
      await t.waitFor(card("DualSense"));
      await t.waitFor(card("GameSir G7 SE"));
      // One page: the tester, polling and lights all on the Overview.
      await t.click(card("DualSense"));
      await t.waitFor("[data-testid='pad-stick-0']", { timeout: 30_000 });
      await t.click("[data-testid='pad-measure-drift']");
      await t.waitFor("[data-testid='pad-stick-figures']", { timeout: 15_000 });
      await t.shot("10-controller-test");
      await t.click("[data-testid='pad-measure-polling']");
      await t.waitFor("[data-testid='pad-polling-hz']", { timeout: 20_000 });
      await t.shot("11-controller-polling");
      await t.click("[data-testid='pad-test-rumble']");
      await t.shot("12-controller-lights");
      // The developer's pad, through XInput: the polling figure from the sampler.
      await t.click(dock("Gear"));
      await t.click(card("GameSir G7 SE"));
      await t.click("[data-testid='pad-measure-polling']");
      await t.waitFor("[data-testid='pad-polling-hz']", { timeout: 20_000 });
      await t.shot("13-controller-xinput-polling");
      // A GameSir Cyclone 2 (simulated): its settings channel, the four profiles read (nothing written).
      await t.click(dock("Gear"));
      await t.click(card("GameSir Cyclone 2"));
      await t.click(tab("Settings"));
      await t.waitFor("[data-testid='gamesir-profile-4']", { timeout: 30_000 });
      await t.shot("14-controller-gamesir-settings");
    },
  },
  {
    name: "opens a lamp, paints it and says when one is out of reach",
    run: async (t) => {
      await t.click(dock("Lights"));
      // The developer's two floor lamps (simulated: src/lib/lighting/govee/sim.ts): one in reach, one heard only faintly.
      await t.waitFor(card("Floor Lamp 7A21"));
      await t.waitFor(card("All lights"));
      await t.click(card("Floor Lamp 7A21"));
      await t.waitFor("[data-testid='light-brightness']", { timeout: 30_000 });
      await t.click("//button[@aria-label='Brush #2a5bff']");
      await t.click("//*[@data-testid='lamp-stage']//*[@role='group']");
      await t.waitFor("//*[@data-testid='lamp-stage'][@data-mode='segments']");
      await t.shot("15-lamp-painted");
      await t.click(tab("Segments"));
      await t.click(button("Aurora"));
      await t.shot("16-lamp-gradient");
      // A scene with data (uploaded, then switched on), from the scenes under the colour on the Light tab, and a DIY
      // effect tried on the lamp.
      await t.click(tab("Light"));
      await t.click("//*[@data-testid='light-scenes']//button[.//span[normalize-space()='Sunset']]");
      await t.waitFor("//*[@data-testid='light-scenes']//button[@aria-pressed='true'][.//span[normalize-space()='Sunset']]", { timeout: 15_000 });
      await t.click(tab("Effects"));
      await t.click("[data-testid='diy-try']");
      await t.waitFor("//*[@data-testid='lamp-stage'][@data-mode='diy']", { timeout: 15_000 });
      await t.shot("16b-lamp-effect");
      // Screen sync (the preview's pretend screen) on the second display: it outlives the page and shows on the
      // Devices home card.
      await t.click(tab("Screen sync"));
      await t.click(display("VG248"));
      await t.click("[data-testid='sync-toggle']");
      await t.waitFor("[data-testid='sync-status']", { timeout: 15_000 });
      await t.waitFor(display("VG248", true), { timeout: 15_000 });
      await t.click(dock("Lights"));
      await t.waitFor("[data-testid='lamp-sync-chip']", { timeout: 15_000 });
      await t.shot("16c-lamp-sync-home");
      await t.click("//*[@data-testid='lamp-sync-chip']//button[normalize-space()='Stop']");
      await t.waitFor("[data-testid='lamp-sync-chip']", { gone: true, timeout: 15_000 });
      await t.click(dock("Lights"));
      await t.click(card("Floor Lamp B308"));
      await t.waitFor(`//*[starts-with(normalize-space(), "Can't reach")]`, { timeout: 30_000 });
      await t.shot("17-lamp-out-of-reach");
    },
  },
  {
    name: "finds Wi-Fi lights only when asked, pairs the Hue bridge and opens a light",
    run: async (t) => {
      await t.click(dock("Lights"));
      // Nothing is looked for until Find lights (the simulated network: src/lib/lighting/net/sim.ts).
      if (await t.count(card("Hue Bridge"))) throw new Error("Wi-Fi lights were listed before Find lights");
      await settle(t, "[data-testid='find-lights-tile']");
      await t.click("[data-testid='find-lights-tile']");
      // The popover is open (data-state) and still, and its button enabled, before the click; the click finds it afresh.
      const go = "//*[@role='dialog'][@aria-label='Find lights'][@data-state='open']//button[@data-testid='find-lights-go'][not(@disabled)]";
      await settle(t, go);
      await t.click(go);
      await t.waitFor(card("Hue Bridge"), { timeout: 15_000 });
      await t.click(card("Hue Bridge"));
      await t.click("[data-testid='net-pair']");
      await t.waitFor(button("Desk lamp"), { timeout: 20_000 });
      await t.click(button("Desk lamp"));
      await t.waitFor("[data-testid='light-brightness']", { timeout: 15_000 });
      await t.shot("17b-wifi-light");
      await t.click(dock("Lights"));
      await t.click(card("Key Light"));
      await t.waitFor("[data-testid='light-kelvin']", { timeout: 15_000 });
      await t.shot("17b2-wifi-key-light");
      // One look for every light, Govee and Wi-Fi alike (wave L5).
      await t.click(dock("Lights"));
      await t.click(card("All lights"));
      await t.waitFor("[data-testid='lights-view']", { timeout: 15_000 });
      await t.click(button("Sunset"));
      await t.shot("17c-all-lights");
      // Screen sync across lights (the preview's pretend screen) on the second display, which stays put while it
      // runs: it outlives the view and shows on the cards.
      await t.click(tab("Screen sync"));
      await t.click(display("VG248"));
      await t.click("[data-testid='lights-sync-toggle']");
      await t.waitFor("[data-testid='lights-sync-status']", { timeout: 15_000 });
      await t.waitFor("//fieldset[@data-testid='sync-monitor'][@disabled]", { timeout: 15_000 });
      await t.waitFor(display("VG248", true), { timeout: 15_000 });
      await t.click(dock("Lights"));
      await t.waitFor("[data-testid='lights-sync-chip']", { timeout: 15_000 });
      await t.click("//*[@data-testid='lights-sync-chip']//button[normalize-space()='Stop']");
      await t.waitFor("[data-testid='lights-sync-chip']", { gone: true, timeout: 15_000 });
    },
  },
  {
    name: "opens a headset and reads it",
    run: async (t) => {
      await t.click(dock("Gear"));
      await t.click(card("Arctis Nova 7"));
      await openTab(t, "Settings");
      // Read over its simulated firmware (src/lib/headsets/sim.ts); nothing changes until Allow changes.
      await t.waitFor(shown("Headset settings"), { timeout: 30_000 });
      await t.waitFor(allowSwitch);
      await t.shot("18-headset");
    },
  },
  {
    name: "opens a monitor, switches its input and keeps it",
    run: async (t) => {
      await t.click(dock("Displays"));
      await t.click(card("VG248"));
      // The picture and the input are on the monitor's one page.
      await t.waitFor(allowSwitch, { timeout: 30_000 });
      await t.click(allowSwitch);
      await t.click(button("HDMI"));
      await t.click(button("Switch"));
      // The switch-back countdown, then Keep it.
      await t.waitFor(shown("Keep HDMI?"), { timeout: 15_000 });
      await t.click(button("Keep it"));
      await t.waitFor(shown("Keep HDMI?"), { gone: true });
      await t.waitFor(`//button[normalize-space()='HDMI'][@aria-pressed='true']`);
      await t.shot("19-monitor-input-kept");
    },
  },
  {
    name: "opens a webcam's controls with the preview off",
    run: async (t) => {
      await t.click(dock("Gear"));
      await t.click(card("C920 HD Pro Webcam"));
      await t.waitFor(shown("Camera controls"), { timeout: 30_000 });
      if (await t.count("//video")) throw new Error("the preview started without being asked");
      await t.click(allowSwitch);
      await t.click(button("50 Hz"));
      await t.waitFor(`//button[normalize-space()='50 Hz'][@aria-pressed='true']`, { timeout: 15_000 });
      await t.shot("20-webcam-controls");
    },
  },
  {
    name: "lights a Dynamic Lighting device with an effect",
    run: async (t) => {
      await t.click(dock("Lights"));
      await t.click(card("Keyboard (Dynamic Lighting)"));
      await t.waitFor(`//*[@role='img'][starts-with(@aria-label, '96 lamps')]`, { timeout: 30_000 });
      await openTab(t, "Light");
      await t.click(radio("Wave"));
      await t.waitFor(`${radio("Wave")}[@aria-checked='true']`);
      await t.shot("21-dynamic-lighting-wave");
    },
  },
  {
    name: "sends an RGB hub one colour and puts the one before back",
    run: async (t) => {
      await t.click(dock("Lights"));
      await t.click(card("NZXT RGB & Fan Controller"));
      await openTab(t, "Light");
      // The simulated hub reports two fans on channel 1 (src/lib/lighting/hidrgb/sim.ts).
      await t.waitFor(shown("F120 RGB fan, F120 RGB fan"), { timeout: 30_000 });
      await t.click(allowSwitch);
      await t.click("(//button[@aria-label='#ff2a2a'])[1]");
      await t.click("(//button[@aria-label='#2a5bff'])[1]");
      await t.click(button("Put back the colour sent before the last one"));
      await t.waitFor(`(//button[@aria-label='#ff2a2a'])[1][@aria-pressed='true']`, { timeout: 15_000 });
      await t.shot("22-hub-put-back");
    },
  },
  {
    name: "runs the checkup to its report",
    run: async (t) => {
      await t.click(dock("Gear"));
      await t.click(button("Run a checkup"));
      await t.click(button("Start checkup"));
      // Every step skipped (no hands on the sample devices here): the report still comes, naming what wasn't checked.
      for (let i = 0; i < 20 && !(await t.count(button("Run again"))); i++) {
        if (await t.count(button("Skip this step"))) await t.click(button("Skip this step"));
        else await pause(500);
      }
      await t.waitFor(button("Run again"), { timeout: 30_000 });
      await t.waitFor(shown("Not checked"));
      await t.shot("23-checkup-report");
      await t.click(button("Done"));
    },
  },
  {
    name: "applies a pro's setup to a mouse and undoes it",
    run: async (t) => {
      await t.click(dock("Gear"));
      // "Keep your feel" opens in a sheet from the Gear page's link.
      await t.click("[data-slot='feel-link']");
      await t.click(`//button[@aria-expanded][.//span[normalize-space()="Try a pro's setup"]]`);
      await t.click("(//*[@role='listbox'][@aria-label='Pros']//button[@role='option'])[1]");
      await t.click(`(//button[starts-with(normalize-space(), 'Apply to ') or (starts-with(normalize-space(), 'Open ') and contains(normalize-space(), ' to apply'))])[1]`);
      // On the mouse's page: the plan, applied through the mouse's own session (backup first), then Undo.
      await t.click(`(//button[starts-with(normalize-space(), 'Apply to ')][${NOT_HIDDEN}])[1]`);
      await t.waitFor(button("Undo"), { timeout: 30_000 });
      await t.shot("24-pro-applied");
      await t.click(button("Undo"));
      await t.waitFor(button("Undo"), { gone: true, timeout: 30_000 });
      await t.shot("25-pro-undone");
    },
  },
  {
    name: "finds a headphone preset and saves it",
    run: async (t) => {
      await t.click(dock("Gear"));
      await t.click(card("Headphones"));
      await openTab(t, "EQ");
      await t.click(`//button[normalize-space()='Find your headphones'][${NOT_HIDDEN}]`);
      // The preview's sample list (src/lib/audio/autoeq-preview.ts): nothing is fetched from GitHub here.
      await t.type(`//input[@aria-label='Search headphones']`, "zero 2");
      await t.click(`//*[@role='listbox'][@aria-label='Models']//*[@role='option'][1]`);
      await t.click(button("Save as preset"));
      await t.waitFor(`//*[starts-with(normalize-space(), 'Saved "')]`, { timeout: 15_000 });
      await t.shot("26-autoeq-saved");
    },
  },
  {
    name: "names a group in the Lights view and sends it a look",
    run: async (t) => {
      await t.click(dock("Lights"));
      await t.click(card("All lights"));
      await t.waitFor("[data-testid='lights-view']", { timeout: 15_000 });
      await t.click(button("New group"));
      await t.type("//input[@aria-label='Group name']", "Desk");
      await t.click(`(//button[@aria-pressed='false'][.//span[normalize-space()='Floor Lamp 7A21']])[1]`);
      await t.click(button("Save group"));
      await t.waitFor(`//*[@role='group'][@aria-label='Groups']//button[normalize-space()='Desk'][@aria-pressed='true']`, { timeout: 15_000 });
      await openTab(t, "Look");
      await t.click(button("Sunset"));
      await t.shot("27b-lights-group-look");
    },
  },
  {
    name: "switches the Gear layout (bento, shelves, spotlight); lights and monitors have their own tabs",
    run: async (t) => {
      await t.click(dock("Gear"));
      // Lights and monitors aren't on the Devices page: each has its own tab.
      if (await t.count(card("Floor Lamp 7A21"))) throw new Error("a lamp is shown under Devices");
      if (await t.count(card("VG248"))) throw new Error("a monitor is shown under Devices");
      // Bento, the default: a card per kind, every device in it.
      await t.waitFor("[data-slot='gear-bento']");
      await t.waitFor(`//section[@aria-label='Controllers']${card("DualSense")}`);
      await t.click(radio("Shelves"));
      await t.waitFor("[data-slot='gear-shelves']");
      await t.waitFor(card("DualSense"));
      await pause(900);
      await t.shot("27-gear-shelves");
      await t.click(radio("Spotlight"));
      await t.waitFor("[data-slot='gear-spotlight']");
      await t.waitFor(`//nav[@aria-label='All devices']//button[@aria-label='Show DualSense']`);
      await pause(900);
      await t.shot("27a-gear-spotlight");
      await t.click(radio("Bento"));
      await t.waitFor(card("X1 V2 Air+"));
      await t.click(dock("Lights"));
      await t.waitFor(card("Floor Lamp 7A21"));
      if (await t.count(card("X1 V2 Air+"))) throw new Error("a mouse is shown under Lights");
      await t.shot("27b-lights-tab");
      await t.click(dock("Displays"));
      await t.waitFor(card("VG248"));
      await t.shot("27c-displays-tab");
    },
  },
  {
    name: "logged no console errors",
    run: async (t) => {
      const errors = await t.errors();
      if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`);
    },
  },
];
