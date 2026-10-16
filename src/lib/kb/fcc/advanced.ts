// Sonix HE boards (Fighting Control Center protocol) Advanced actions: a guided switch calibration and a
// factory reset with "Restore my settings". Each runs behind the panel's confirmation
// (src/lib/advanced/core.ts), through the same checked link as everything else (sonix-protocol.ts checkFrame,
// mirrored by src-tauri/src/brands.rs `sonix_with`).
//
// Sources: FCC's docs/PROTOCOL.md (docs of shybruh/FightingControlCenter-FCC, GPL-3.0): 0x64 starts travel
// calibration and streams 0xFB sensor packets, 0x65 ends and saves it ("keys not pressed during the session
// keep their previous bottom"), [0x0F, 0xFF] is the factory reset of every setting.
//
// Calibration: the old per-key bottom readings are captured from the stream before anything is pressed and
// saved (the board can't be asked to take them back, so they are information only); a key counts as done once
// it has been pressed to 90% of its full travel; the end frame is ALWAYS sent (done, aborted, timed out or
// failed) so the keyboard never stays in calibration mode; it is cancelled on anomalies (no stream, a key
// with more travel than it has, a bottom that came out shallower than before). No Tauri, no React.
import { confirmationProblem, type AdvancedGate } from "../../advanced/core.ts";
import { firmwareInfo } from "../../advanced/firmware.ts";
import {
  noFeatures,
  withFeatures,
  type AdvancedPanel,
  type CalibrateApi,
  type CalibrateProgress,
  type CalibrateTarget,
  type ResetApi,
} from "../../advanced/types.ts";
import type { KbStore } from "../types.ts";
import * as P from "./sonix-protocol.ts";
import type { SonixLink, SonixRegions } from "./sonix-link.ts";

export interface FccAdvancedSource {
  link: SonixLink;
  gate: AdvancedGate;
  store: KbStore | undefined;
  deviceName: string;
  firmware: string;
  /** Why nothing may be written at all, when that is so. */
  hardBlock(): string | null;
  /** Key indexes that have a switch, and their names. */
  keys(): readonly { index: number; label: string }[];
  /** Reads the keyboard again so the panel shows what it holds now. */
  reload(): Promise<void>;
  wait?: (ms: number) => Promise<void>;
}

const SRC = "Fighting Control Center's Sonix protocol (docs/PROTOCOL.md)";
const FULL = 0.9; // a key is done at 90% of its full travel
const PARTIAL = 0.15;
const TIMEOUT_S = 300;
const SILENT_MS = 3000;

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "keyboard";

export function fccAdvanced(src: FccAdvancedSource): AdvancedPanel {
  const { link, gate } = src;
  const wait = src.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const prefix = `kb-sonix-${slug(src.deviceName)}`;
  const regionsJson = (r: SonixRegions) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, hex(v)]));

  const save = async (name: string, body: unknown) => {
    if (!src.store) throw new Error("There is nowhere to keep a backup, so SYNQ won't change this keyboard.");
    return src.store.saveBackup(`${prefix}-${name}`, JSON.stringify({ savedAt: new Date().toISOString(), device: src.deviceName, firmware: src.firmware, ...(body as object) }, null, 1));
  };

  // ---------------------------------------------------------------------------------------------
  // Calibration
  // ---------------------------------------------------------------------------------------------
  const calibrate: CalibrateApi = {
    steps: [
      "Keep your fingers off the keys until the next step.",
      "When it starts, press every key all the way down, then let go. Each key lights up here once it has been pressed fully.",
      "A key you skip keeps its old calibration. Don't unplug the keyboard until it says it's done.",
    ],
    timeoutSeconds: TIMEOUT_S,
    canRestore: false,
    restoreNote: "This keyboard can't take its old calibration back. SYNQ saves the old readings in the backup file for reference; if the result feels wrong, run the calibration again.",
    async run(confirmation, onProgress, signal) {
      const unconfirmed = confirmationProblem("calibrate", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      const block = src.hardBlock();
      if (block) throw new Error(block);
      // 1. the whole keyboard as it is now, saved before anything is sent
      const regions = await link.run(() => link.readAll());
      let backupPath = await save("before-calibration", { note: "Everything SYNQ read from this keyboard before a switch calibration from the Advanced card.", regions: regionsJson(regions) });

      const names = new Map(src.keys().map((k) => [k.index, k.label]));
      let targets: CalibrateTarget[] = [];
      let last: CalibrateProgress = { phase: "starting", targets, depth: null, message: "Starting calibration…", backupPath };
      const say = (p: Partial<CalibrateProgress>) => (onProgress((last = { ...last, ...p, backupPath })), last);
      say({});

      const baseline = new Map<number, P.SensorPacket>();
      const latest = new Map<number, P.SensorPacket>();
      const maxTravel = new Map<number, number>();
      let lastPacketAt = Date.now();
      let anomaly: string | null = null;
      const off = link.onSensor((p) => {
        lastPacketAt = Date.now();
        latest.set(p.key, p);
        if (baseline.size && !baseline.has(p.key)) anomaly = `Key ${p.key} appeared in the stream but isn't on this keyboard.`;
        if (p.fullTravel > 0 && p.travel > p.fullTravel * 1.5) anomaly = `${names.get(p.key) ?? `Key ${p.key}`} reported more travel than it has.`;
        maxTravel.set(p.key, Math.max(maxTravel.get(p.key) ?? 0, p.travel));
      });
      await gate.grant("calibrate", confirmation);
      let started = false;
      let ended = false;
      const end = async () => {
        if (!started || ended) return;
        ended = true;
        await link.run(() => link.sendOnly(P.encodeCalibrationEnd())).catch(() => undefined);
      };
      const timeoutAt = Date.now() + TIMEOUT_S * 1000;
      try {
        await link.run(() => link.sendOnly(P.encodeCalibrationStart()));
        started = true;
        // 2. the stream's first second is the old calibration, before any key is touched
        await wait(1500);
        for (const [k, p] of latest) baseline.set(k, p);
        if (!baseline.size) {
          await end();
          return say({ phase: "failed", message: "The keyboard didn't send any sensor data, so SYNQ ended calibration. Nothing was changed." });
        }
        backupPath = await save("old-calibration", { note: "The per-key calibration readings the keyboard reported at the start of a calibration (information only: they can't be written back).", keys: [...baseline.values()].map((p) => ({ key: p.key, name: names.get(p.key) ?? null, restTop: p.top, bottom: p.bottom, fullTravel01mm: p.fullTravel })) });
        const ids = [...baseline.keys()].sort((a, b) => a - b);
        const stateOf = (k: number): CalibrateTarget["state"] => {
          const full = baseline.get(k)!.fullTravel || latest.get(k)?.fullTravel || 0;
          const m = maxTravel.get(k) ?? 0;
          return full > 0 && m >= full * FULL ? "done" : full > 0 && m >= full * PARTIAL ? "partial" : "waiting";
        };
        const view = () => ids.map((k): CalibrateTarget => ({ id: String(k), label: names.get(k) ?? `Key ${k}`, state: stateOf(k) }));
        say({ phase: "pressing", targets: view(), message: "Press every key all the way down, then let go." });
        // 3. follow the presses
        for (;;) {
          if (signal.aborted) {
            await end();
            return say({ phase: "aborted", targets: view(), message: "Stopped. Calibration mode is ended; keys you hadn't pressed fully keep their old calibration." });
          }
          if (Date.now() > timeoutAt) {
            await end();
            return say({ phase: "timeout", targets: view(), message: "That took too long, so SYNQ ended calibration. Keys you hadn't pressed keep their old calibration." });
          }
          if (link.state !== "ok") return say({ phase: "failed", targets: view(), message: "The keyboard disconnected during calibration. Plug it in and run it again." });
          if (Date.now() - lastPacketAt > SILENT_MS) {
            await end();
            return say({ phase: "failed", targets: view(), message: "The keyboard stopped sending sensor data, so SYNQ ended calibration." });
          }
          if (anomaly) {
            await end();
            return say({ phase: "failed", targets: view(), message: `${anomaly} SYNQ ended calibration.` });
          }
          const t = view();
          const live = [...latest.values()].reduce((m, p) => Math.max(m, p.fullTravel ? p.travel / p.fullTravel : 0), 0);
          say({ targets: t, depth: Math.min(1, live) });
          if (t.every((x) => x.state === "done")) break;
          await wait(100);
        }
        // 4. save, and check what came out
        say({ phase: "saving", message: "Saving the calibration…", depth: null });
        await end();
        await wait(500);
        const shallower = ids.filter((k) => (latest.get(k)?.bottom ?? 0) > baseline.get(k)!.bottom);
        if (shallower.length) {
          return say({ phase: "failed", targets: view(), message: `${shallower.map((k) => names.get(k) ?? `Key ${k}`).slice(0, 4).join(", ")} came out shallower than before. Run the calibration again and press each key all the way down.` });
        }
        return say({ phase: "done", targets: view(), message: "Calibrated. The keyboard is using the new calibration." });
      } catch (e) {
        await end();
        return say({ phase: "failed", message: String(e).replace(/^Error: /, "") });
      } finally {
        off();
        await end();
        await gate.revoke("calibrate");
      }
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Factory reset
  // ---------------------------------------------------------------------------------------------
  let kept: { path: string; regions: SonixRegions } | null = null;
  const RESTORE_ORDER: P.RegionName[] = ["settings", "keys", "led", "colors", "macros", "rt", "dks"];

  const backupAll = async () => {
    const regions = await link.run(() => link.readAll());
    const path = await save("before-reset", { note: "Every region SYNQ can read from this keyboard before a factory reset. 'Restore my settings' writes them back.", regions: regionsJson(regions) });
    kept = { path, regions };
    return path;
  };

  const reset: ResetApi = {
    wipes: ["Every setting goes back to the factory values: keys, lighting, actuation and rapid-trigger settings, macros and the other switches.", "The keyboard's switch calibration is not part of the reset."],
    backup: backupAll,
    async reset(confirmation) {
      const unconfirmed = confirmationProblem("reset", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      const block = src.hardBlock();
      if (block) throw new Error(block);
      const backupPath = await backupAll(); // always first
      await gate.grant("reset", confirmation);
      try {
        await link.run(() => link.sendOnly(P.encodeFactoryReset()));
        await wait(2000);
      } finally {
        await gate.revoke("reset");
      }
      await src.reload().catch(() => undefined);
      return { backupPath };
    },
    canRestore: () => kept !== null,
    async restore(confirmation) {
      if (!kept) throw new Error("There is no saved copy to put back.");
      if (!confirmation.acknowledged) throw new Error("Restoring needs your confirmation.");
      const saved = kept.regions;
      const skipped: string[] = [];
      for (const name of RESTORE_ORDER) {
        // The board reads its lighting constants back as 0 (bytes 4, 14, 15); the official driver always writes 255, 0xAA, 0x55.
        const data = Uint8Array.from(saved[name]);
        if (name === "led") [data[4], data[14], data[15]] = [255, 0xaa, 0x55];
        const frames = P.encodeRegionWrite(name, data);
        const bad = frames.map((f) => P.checkFrame(f)).find((c) => !c.ok);
        if (bad && !bad.ok) {
          skipped.push(`${name} (${bad.reason})`);
          continue;
        }
        await link.run(() => link.writeRegions([[name, data]], `Restore ${name}`));
      }
      await src.reload().catch(() => undefined);
      if (skipped.length) throw new Error(`Put back everything except: ${skipped.join("; ")}. The backup file still holds it.`);
    },
  };

  const block = src.hardBlock();
  const none = (why: string) => ({ available: false, source: "", why });
  const features = withFeatures(noFeatures("SYNQ has no documented commands for this on Sonix boards."), {
    pair: none("A wired Sonix board has nothing to pair."),
    remap: none("Plain key changes are already in the Keys section; the Advanced card adds nothing for this board."),
    macros: none("This board's macros are shown but SYNQ doesn't edit them yet."),
    calibrate: block || !src.store ? none(block ?? "There is nowhere to keep a backup here.") : { available: true, source: SRC },
    reset: block || !src.store ? none(block ?? "There is nowhere to keep a backup here.") : { available: true, source: SRC },
  });
  return {
    deviceName: src.deviceName,
    kind: "keyboard",
    gate,
    features,
    firmware: firmwareInfo("Sonix", [{ part: "Firmware", version: src.firmware }], "Sonix boards update through their maker's driver. SYNQ never flashes firmware."),
    calibrate: features.calibrate.available ? calibrate : undefined,
    reset: features.reset.available ? reset : undefined,
  };
}
