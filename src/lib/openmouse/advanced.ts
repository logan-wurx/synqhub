// Advanced actions for the generic (OpenMouse) mouse path: button changes, magnetic-button calibration, a
// factory reset and receiver pairing, each only where the mouse's OpenMouse driver offers the method and
// only through SafeMouse (safe-mouse.ts), which calls the driver by name from policy.ts's ADVANCED_METHODS
// list while the mouse's AdvancedGate holds a live token. Everything else a driver can do (firmware, un-pair,
// profile wipes, macros, raw reports...) stays unreachable.
//
// The browser/desktop bridge cannot judge OpenMouse's per-brand frames, so on this path the guard is the
// TypeScript one only (policy.ts); the bridge still opens nothing but the vendor collections.
// No Tauri, no React.
import type { MouseStatus } from "@openmouse/protocol/drivers";
import { confirmationProblem, type AdvancedGate, type AdvancedScope } from "../advanced/core.ts";
import { firmwareInfo, splitVersion } from "../advanced/firmware.ts";
import { LEFT_CLICK_LOCK, mouseButtonsProblem, mouseChangeProblem } from "../advanced/lockout.ts";
import {
  noFeatures,
  withFeatures,
  type AdvancedPanel,
  type ButtonSlot,
  type ButtonsApi,
  type ButtonsState,
  type CalibrateApi,
  type CalibrateProgress,
  type CalibrateTarget,
  type PairApi,
  type ResetApi,
} from "../advanced/types.ts";

/** What the panel builder needs from SafeMouse. */
export interface MouseAdvancedHost {
  gate: AdvancedGate;
  name: string;
  brand: string;
  driver: string;
  /** The last status SafeMouse read. */
  status(): MouseStatus;
  /** Reads the mouse again (and updates SafeMouse's snapshot). */
  reread(): Promise<MouseStatus>;
  /** Whether the driver has this method at all. */
  has(method: string): boolean;
  /** Calls a driver method for one Advanced scope; refused unless policy.ts and the gate agree. */
  call(scope: AdvancedScope, method: string, ...args: unknown[]): Promise<unknown>;
  /** Saves a backup file; returns where it went. */
  save(name: string, body: unknown): Promise<string>;
  /** Waits; injected so tests don't. */
  wait?: (ms: number) => Promise<void>;
  /** The default-path changes (DPI, polling...) SafeMouse already makes, for putting settings back after a reset. */
  restoreSettings(status: MouseStatus): Promise<{ restored: number; skipped: string[] }>;
}

const SRC_REMAP = "OpenMouse's shared button remapper (setButtonMapping)";
const SRC_CAL = "OpenMouse magnetic-button calibration (calibrateMagneticButtons)";
const SRC_RESET = "the OpenMouse driver's factoryReset";
const SRC_PAIR = "OpenMouse's ASUS Omni driver (setOmniPairingMode)";

/** Whether an action label means "left click" (drivers spell it "Left click", "Left Button", "Left"...). */
export const isLeftClickLabel = (label: string | undefined): boolean => !!label && /^left(\s+(click|button|mouse(\s+button)?))?$/i.test(label.trim());

/** The physical button that sends left click, by the name the driver gives it. */
export function primaryButtonName(status: MouseStatus): string | null {
  const wanted = (status.primaryButton ?? "Left").toLowerCase();
  const names = Object.keys(status.buttonMappings ?? {});
  return names.find((n) => n.toLowerCase().replace(/\s*button$/i, "") === wanted) ?? null;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Array.from(x) : x instanceof Map ? Object.fromEntries(x) : typeof x === "bigint" ? String(x) : x)));

export function mouseAdvanced(h: MouseAdvancedHost): AdvancedPanel {
  const { gate } = h;
  const status0 = h.status();

  // ---------------------------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------------------------
  const primary = primaryButtonName(status0);
  const options = status0.buttonOptions ?? [];
  const leftOption = options.find(isLeftClickLabel);
  const canRemap = h.has("setButtonMapping") && !!status0.buttonMappings && options.length > 0 && !!primary && !!leftOption && isLeftClickLabel(status0.buttonMappings[primary]);
  let held: { original: Record<string, string>; current: Record<string, string>; backupPath: string } | null = null;

  const buttonsState = (): ButtonsState => {
    const k = held!;
    const fixed = new Set(h.status().fixedButtons ?? []);
    const slots: ButtonSlot[] = Object.keys(k.current).map((name) => {
      const left = name === primary;
      const locked = left || fixed.has(name);
      return {
        id: name,
        label: name,
        action: k.current[name] ?? null,
        actionLabel: k.current[name] ?? "Unknown",
        locked,
        lockedWhy: left ? "The left button always stays left click." : fixed.has(name) ? "This button holds something set in the maker's app (a macro or an action SYNQ can't show). SYNQ leaves it alone." : undefined,
        choices: options.map((o) => ({ id: o, label: o })),
        changed: k.current[name] !== k.original[name],
      };
    });
    return { slots, backupPath: k.backupPath };
  };

  const leftCheck = (map: Record<string, string>) => mouseButtonsProblem(Object.entries(map).map(([id, action]) => ({ id, leftClick: isLeftClickLabel(action) })), primary!);

  const buttons: ButtonsApi = {
    async begin(confirmation) {
      const unconfirmed = confirmationProblem("remap", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      const status = await h.reread();
      const map = { ...(status.buttonMappings ?? {}) };
      if (!primary || !isLeftClickLabel(map[primary])) throw new Error("The left button doesn't read as left click on this mouse, so SYNQ won't change its buttons.");
      const backupPath = await h.save("buttons", { note: "The mouse's buttons before changes from the Advanced card.", buttonMappings: map, fixedButtons: status.fixedButtons ?? [], status: json(status) });
      await gate.grant("remap", confirmation);
      held = { original: { ...map }, current: { ...map }, backupPath };
      return buttonsState();
    },
    async set(slotId, actionId) {
      if (!held) throw new Error("Start button changes first.");
      if (!(slotId in held.current)) throw new Error("That isn't a button on this mouse.");
      if (!options.includes(actionId)) throw new Error("This mouse doesn't offer that action.");
      const lock = mouseChangeProblem({ slot: slotId, toLeftClick: isLeftClickLabel(actionId) }, primary!);
      if (lock) throw new Error(lock);
      if ((h.status().fixedButtons ?? []).includes(slotId)) throw new Error("That button holds something set in the maker's app; SYNQ leaves it alone.");
      if (held.current[slotId] === actionId) return buttonsState();
      const next = { ...held.current, [slotId]: actionId };
      const bad = leftCheck(next);
      if (bad) throw new Error(bad);
      await h.call("remap", "setButtonMapping", slotId, actionId);
      const after = await h.reread();
      const got = after.buttonMappings?.[slotId];
      held.current = { ...(after.buttonMappings ?? next) };
      if (got !== actionId) throw new Error(`The mouse reports "${got ?? "nothing"}" for ${slotId} instead of "${actionId}".`);
      return buttonsState();
    },
    async undoAll() {
      if (!held) throw new Error("Start button changes first.");
      const fixed = new Set(h.status().fixedButtons ?? []);
      for (const [name, was] of Object.entries(held.original)) {
        if (held.current[name] === was || fixed.has(name)) continue;
        await h.call("remap", "setButtonMapping", name, was);
      }
      const after = await h.reread();
      held.current = { ...(after.buttonMappings ?? held.original) };
      return buttonsState();
    },
    async end() {
      held = null;
      await gate.revoke("remap");
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Magnetic calibration
  // ---------------------------------------------------------------------------------------------
  const canCalibrate = h.has("calibrateMagneticButtons") && !!status0.magneticButtons && status0.magneticButtons.calibration !== null;
  const CAL_TIMEOUT_S = 180;
  const calibrate: CalibrateApi = {
    steps: [
      "Keep your fingers off the left and right buttons until the next step asks for them.",
      "Press each button all the way down when SYNQ asks, then let go.",
      "Don't unplug or switch the mouse off until it says it's done.",
    ],
    timeoutSeconds: CAL_TIMEOUT_S,
    canRestore: false,
    restoreNote: "The old calibration can't be read back from the mouse, so it can't be written back. If the new one feels wrong, run the calibration again.",
    async run(confirmation, onProgress, signal) {
      const unconfirmed = confirmationProblem("calibrate", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      const status = await h.reread();
      const before = status.magneticButtons;
      // What the mouse reports right now is saved first; the calibration itself can't be read.
      const backupPath = await h.save("before-calibration", { note: "The mouse's magnetic-button settings before a calibration from the Advanced card.", magneticButtons: json(before), status: json(status) });
      const targets = (state: [CalibrateTarget["state"], CalibrateTarget["state"]]): CalibrateTarget[] => [
        { id: "left", label: "Left button", state: state[0] },
        { id: "right", label: "Right button", state: state[1] },
      ];
      const stateOf = (p: number): CalibrateTarget["state"] => (p >= 100 ? "done" : p > 0 ? "partial" : "waiting");
      let last: CalibrateProgress = { phase: "starting", targets: targets(["waiting", "waiting"]), depth: null, message: "Starting the calibration…", backupPath };
      const say = (p: Partial<CalibrateProgress>) => {
        last = { ...last, ...p, backupPath };
        onProgress(last);
        return last;
      };
      say({});
      await gate.grant("calibrate", confirmation);
      const inner = new AbortController();
      const stop = () => inner.abort();
      signal.addEventListener("abort", stop);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        inner.abort();
      }, CAL_TIMEOUT_S * 1000);
      try {
        await h.call("calibrate", "calibrateMagneticButtons", (p: { left: number; right: number; message: string }) => {
          say({ phase: "pressing", targets: targets([stateOf(p.left), stateOf(p.right)]), depth: Math.max(p.left, p.right) / 100, message: p.message });
        }, inner.signal);
        // The mouse says it succeeded; read it again to see what it reports.
        const after = await h.reread().catch(() => null);
        const calibrated = after?.magneticButtons?.calibration;
        return say({ phase: "done", targets: targets(["done", "done"]), depth: null, message: calibrated === "needed" ? "The mouse still says it needs calibrating. Run it again." : "Calibrated. The mouse is using the new calibration." });
      } catch (e) {
        const msg = String(e).replace(/^Error: /, "");
        if (timedOut) return say({ phase: "timeout", message: "That took too long, so SYNQ stopped it. Run it again when you're ready." });
        if (signal.aborted || /cancel/i.test(msg)) return say({ phase: "aborted", message: "Stopped. The mouse keeps whatever it had; run it again if it feels wrong." });
        return say({ phase: "failed", message: msg });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        await gate.revoke("calibrate");
      }
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Factory reset
  // ---------------------------------------------------------------------------------------------
  const canReset = h.has("factoryReset");
  let kept: { path: string; status: MouseStatus } | null = null;
  const backupAll = async () => {
    const status = await h.reread();
    const path = await h.save("before-reset", { note: "Everything SYNQ read from this mouse before a factory reset from the Advanced card. 'Restore my settings' puts the settings back.", status: json(status) });
    kept = { path, status: structuredClone(status) };
    return path;
  };
  const reset: ResetApi = {
    wipes: ["Sensitivity, polling rate, lift-off, lighting and the other settings go back to the maker's factory values.", "Button changes go back to the factory buttons.", "Anything you set up in the maker's app may go back to factory too."],
    backup: backupAll,
    async reset(confirmation) {
      const unconfirmed = confirmationProblem("reset", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      const backupPath = await backupAll();
      await gate.grant("reset", confirmation);
      try {
        await h.call("reset", "factoryReset");
      } finally {
        await gate.revoke("reset");
      }
      await h.reread().catch(() => undefined);
      return { backupPath };
    },
    canRestore: () => kept !== null,
    async restore(confirmation) {
      if (!kept) throw new Error("There is no saved copy to put back.");
      if (!confirmation.acknowledged) throw new Error("Restoring needs your confirmation.");
      const saved = kept.status;
      await h.restoreSettings(saved);
      // The buttons, if this mouse has them and they differ from what the reset left.
      const mappings = saved.buttonMappings;
      if (canRemap && mappings && primary) {
        await gate.grant("remap", { acknowledged: true });
        try {
          const now = (await h.reread()).buttonMappings ?? {};
          const fixed = new Set(saved.fixedButtons ?? []);
          for (const [name, action] of Object.entries(mappings)) {
            if (now[name] === action || fixed.has(name) || !options.includes(action)) continue;
            if (name === primary && !isLeftClickLabel(action)) continue; // never
            await h.call("remap", "setButtonMapping", name, action);
          }
        } finally {
          await gate.revoke("remap");
        }
      }
      await h.reread().catch(() => undefined);
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Pairing (ASUS Omni receiver)
  // ---------------------------------------------------------------------------------------------
  const canPair = h.has("setOmniPairingMode");
  const PAIR_S = 60;
  const pair: PairApi = {
    steps: [
      "Put the mouse in pairing mode as its manual describes (usually: switch it off, then hold its pairing button while switching it on).",
      "Press Start below. The receiver listens for about a minute.",
      "Wait for SYNQ to see the mouse join the receiver.",
    ],
    timeoutSeconds: PAIR_S,
    async run(confirmation, onProgress, signal) {
      const unconfirmed = confirmationProblem("pair", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      const ids = (s: MouseStatus) => (s.asusOmni?.devices ?? []).map((d) => d.productId);
      const say = (phase: "starting" | "waiting" | "paired" | "timeout" | "failed" | "cancelled", message: string, secondsLeft: number | null) => {
        const p = { phase, message, secondsLeft };
        onProgress(p);
        return p;
      };
      await gate.grant("pair", confirmation);
      try {
        const known = new Set(ids(await h.reread()));
        say("starting", "Telling the receiver to listen for a mouse…", PAIR_S);
        await h.call("pair", "setOmniPairingMode", true);
        for (let t = 0; t < PAIR_S; t += 2) {
          if (signal.aborted) return say("cancelled", "Stopped. Pairing mode is switched off again.", null);
          await (h.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(2000);
          const fresh = ids(await h.reread().catch(() => h.status())).filter((id) => !known.has(id));
          if (fresh.length) return say("paired", "Paired. The receiver lists the new mouse.", null);
          say("waiting", `Waiting for the mouse… ${PAIR_S - t - 2} s left.`, PAIR_S - t - 2);
        }
        return say("timeout", "No mouse joined in time; nothing was changed.", 0);
      } catch (e) {
        return say("failed", String(e).replace(/^Error: /, ""), null);
      } finally {
        await h.call("pair", "setOmniPairingMode", false).catch(() => undefined);
        await gate.revoke("pair");
      }
    },
  };

  // ---------------------------------------------------------------------------------------------
  // The card
  // ---------------------------------------------------------------------------------------------
  const none = (why: string) => ({ available: false, source: "", why });
  const features = withFeatures(noFeatures("This isn't available for this mouse in SYNQ yet."), {
    pair: canPair ? { available: true, source: SRC_PAIR } : none("Pairing isn't available for this mouse in SYNQ yet."),
    remap: canRemap
      ? { available: true, source: SRC_REMAP }
      : none(
          !h.has("setButtonMapping")
            ? "Button changes aren't available for this mouse in SYNQ yet."
            : "SYNQ can't tell which button and action are left click on this mouse, so it can't protect them and leaves the buttons alone.",
        ),
    macros: none("Macros stay in the maker's app: these drivers don't share one macro format SYNQ can check."),
    calibrate: canCalibrate ? { available: true, source: SRC_CAL } : none(h.has("calibrateMagneticButtons") ? "The mouse didn't report that it can be calibrated from here." : "This mouse has no calibration SYNQ can run."),
    reset: canReset ? { available: true, source: SRC_RESET } : none("Factory reset isn't available for this mouse in SYNQ yet."),
  });

  return {
    deviceName: h.name,
    kind: "mouse",
    gate,
    features,
    firmware: firmwareInfo(h.brand, (status0.firmware ?? []).map(splitVersion), "Updates come from the maker's own app. SYNQ never flashes firmware."),
    pair: canPair ? pair : undefined,
    buttons: canRemap ? buttons : undefined,
    calibrate: canCalibrate ? calibrate : undefined,
    reset: canReset ? reset : undefined,
  };
}

export { LEFT_CLICK_LOCK };
