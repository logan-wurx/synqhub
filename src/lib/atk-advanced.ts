// Advanced actions for the ATK X1 V2 Air+: pairing, button changes and a factory reset, each behind the
// panel's confirmation (src/lib/advanced/core.ts) and each through the same checked wire as everything
// else (atk-protocol.ts checkFrame, mirrored by src-tauri/src/hid.rs `atk_frame_allowed`).
//
// Sources: ATK HUB 3.2.27 (hub.atk.pro): the pairing flow (SetWirelessDonglePair with the mouse's CID/MID,
// then GetWirelessDonglePairResult once a second for 30 s; status 3 = paired), RestoreFactory, and the
// button rows key0..key5 at 0x0060 with the model's `buttonKeys`; @openmouse/protocol ATK
// (atkBuildReceiverPairRequest, atkDecodePairingStatus, ATK_R1_BUTTONS, atkDecodeButtonAssignment).
// Not offered, because SYNQ's sources don't document them well enough to write: macros, shortcut keys.
// No Tauri, no React: the panel passes in what it has.
import { AdvancedGate, confirmationProblem } from "./advanced/core.ts";
import { firmwareInfo } from "./advanced/firmware.ts";
import { mouseButtonsProblem, mouseChangeProblem } from "./advanced/lockout.ts";
import {
  noFeatures,
  withFeatures,
  type AdvancedPanel,
  type ButtonChoice,
  type ButtonSlot,
  type ButtonsApi,
  type ButtonsState,
  type PairApi,
  type PairProgress,
  type ResetApi,
} from "./advanced/types.ts";
import * as P from "./atk-protocol.ts";
import { NoReply, Wire, hex, sleep } from "./atk-wire.ts";

export interface AtkAdvancedDeps {
  wire: Wire;
  gate: AdvancedGate;
  cid: number;
  mid: number;
  deviceName: string;
  wireless: boolean;
  /** The panel's own writable flag: a checked model on a checked link. */
  writable: boolean;
  firmware: string | null;
  receiverFirmware: string | null;
  /** Saves a backup file; returns where it went. */
  save(prefix: string, json: string): Promise<string>;
  /** Reads the panel again after an Advanced action changed the mouse. */
  refresh(): Promise<void>;
  /** Waits (injected so tests don't). */
  wait?: (ms: number) => Promise<void>;
}

const BUTTON_PREFIX = "atk-x1-v2-air-buttons";
const RESET_PREFIX = "atk-x1-v2-air-before-reset";

const SOURCE = "ATK HUB 3.2.27 and OpenMouse's ATK driver";

const choiceId = (a: P.ButtonAction) => (a.kind === "off" ? "off" : `${a.kind}:${a.value}`);
const parseChoice = (id: string): P.ButtonAction | null => {
  if (id === "off") return { kind: "off" };
  const m = /^(mouse|dpi):(\d+)$/.exec(id);
  if (!m) return null;
  const action: P.ButtonAction = { kind: m[1] as "mouse" | "dpi", value: Number(m[2]) };
  return P.unpackButton(P.packButton(action)) ? action : null;
};
const choiceLabel = (a: P.ButtonAction) => (a.kind === "off" ? "Off" : a.kind === "mouse" ? P.MOUSE_BUTTON_VALUES[a.value] : P.DPI_CONTROL_VALUES[a.value]);

const CHOICES: readonly ButtonChoice[] = [
  { id: "off", label: "Off" },
  ...Object.keys(P.MOUSE_BUTTON_VALUES).map((v) => ({ id: `mouse:${v}`, label: P.MOUSE_BUTTON_VALUES[Number(v)] })),
  ...Object.keys(P.DPI_CONTROL_VALUES).map((v) => ({ id: `dpi:${v}`, label: P.DPI_CONTROL_VALUES[Number(v)] })),
];

const isLeftClick = (a: P.ButtonAction | null) => a?.kind === "mouse" && a.value === 1;

interface Held {
  rows: number[][];
  original: number[][];
  backupPath: string;
}

export function atkAdvanced(d: AtkAdvancedDeps): AdvancedPanel {
  const wait = d.wait ?? sleep;
  const { wire, gate } = d;

  // ---------------------------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------------------------
  const pair: PairApi = {
    steps: [
      "Switch the mouse off with its power switch.",
      "Press Start below. The receiver listens for about 30 seconds.",
      "Switch the mouse back on now, and wait. It joins the receiver on its own.",
    ],
    timeoutSeconds: P.PAIR_WINDOW_SECONDS,
    async run(confirmation, onProgress, signal) {
      const say = (p: PairProgress) => (onProgress(p), p);
      await gate.grant("pair", confirmation);
      try {
        say({ phase: "starting", secondsLeft: P.PAIR_WINDOW_SECONDS, message: "Telling the receiver to listen for a mouse…" });
        try {
          await wire.exchange(P.buildPairRequest(d.cid, d.mid), (r) => r[0] === 0x05 && r[1] === 0 && P.frameChecksumOk(r), 1500);
        } catch (e) {
          return say({ phase: "failed", secondsLeft: null, message: `The receiver didn't take the pairing request (${String(e).replace(/^Error: /, "")}).` });
        }
        let ticks = 0;
        let misses = 0;
        const limit = P.PAIR_WINDOW_SECONDS + 5;
        while (ticks < limit) {
          if (signal.aborted) return say({ phase: "cancelled", secondsLeft: null, message: "Stopped. The receiver stops listening by itself within about 30 seconds." });
          await wait(1000);
          ticks++;
          const left = Math.max(0, P.PAIR_WINDOW_SECONDS - ticks);
          let result: { status: number; secondsLeft: number } | null = null;
          try {
            result = P.decodePairResult(await wire.exchange(P.buildPairResult(), (r) => r[0] === 0x06 && r[1] === 0, 800));
            misses = 0;
          } catch (e) {
            if (!(e instanceof NoReply) || ++misses >= 5) return say({ phase: "failed", secondsLeft: null, message: "The receiver stopped answering while pairing." });
          }
          if (result?.status === P.PAIR_STATUS_PAIRED) {
            const online = await wire.command(P.CMD.getMouseOnline).catch(() => null);
            return say({
              phase: "paired",
              secondsLeft: null,
              message: online && online[P.DATA_OFFSET] === 1 ? "Paired. The mouse is connected to this receiver." : "The receiver says it paired. Move the mouse to wake it up.",
            });
          }
          say({ phase: "waiting", secondsLeft: left, message: left > 0 ? `Waiting for the mouse… ${left} s left. Switch it off and on now.` : "Almost out of time…" });
        }
        return say({ phase: "timeout", secondsLeft: 0, message: "No mouse joined in time. Switch it off and on and try again; nothing was changed." });
      } finally {
        await gate.revoke("pair");
      }
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------------------------
  let held: Held | null = null;

  const readRows = async () => {
    const rows: number[][] = [];
    for (let i = 0; i < P.KEY_ROW.count; i++) rows.push(await wire.read(P.keyRowAddress(i), P.KEY_ROW.length));
    return rows;
  };

  const state = (): ButtonsState => {
    const h = held!;
    const slots: ButtonSlot[] = P.BUTTONS.map((b, i) => {
      const action = P.unpackButton(h.rows[i]);
      const left = i === 0;
      return {
        id: b.id,
        label: b.label,
        action: action ? choiceId(action) : null,
        actionLabel: action ? choiceLabel(action) : "Something SYNQ doesn't write (a macro or shortcut)",
        locked: left || !action,
        lockedWhy: left ? "The left button always stays left click." : !action ? "Set in ATK HUB (a macro or shortcut). SYNQ leaves it alone." : undefined,
        choices: CHOICES,
        changed: h.rows[i].join() !== h.original[i].join(),
      };
    });
    return { slots, backupPath: h.backupPath };
  };

  const buttons: ButtonsApi = {
    async begin(confirmation) {
      if (!d.writable) throw new Error("This mouse can't be changed from SYNQ yet, so its buttons can't be either.");
      const unconfirmed = confirmationProblem("remap", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      // 1. read, 2. back up, 3. only then take the real grant.
      const rows = await readRows();
      const leftAction = P.unpackButton(rows[0]);
      if (!isLeftClick(leftAction)) throw new Error("The left button doesn't read as left click on this mouse, so SYNQ won't change its buttons.");
      const backupPath = await d.save(
        BUTTON_PREFIX,
        JSON.stringify({ savedAt: new Date().toISOString(), device: `ATK ${d.deviceName}`, cidMid: `${d.cid},${d.mid}`, buttons: P.BUTTONS.map((b, i) => ({ id: b.id, row: hex(rows[i]) })) }, null, 1),
      );
      await gate.grant("remap", confirmation);
      held = { rows, original: rows.map((r) => [...r]), backupPath };
      return state();
    },
    async set(slotId, actionId) {
      if (!held) throw new Error("Start button changes first.");
      const i = P.BUTTONS.findIndex((b) => b.id === slotId);
      if (i < 0) throw new Error("That isn't a button on this mouse.");
      const action = parseChoice(actionId);
      if (!action) throw new Error("SYNQ doesn't write that action to a button.");
      const lock = mouseChangeProblem({ slot: slotId, toLeftClick: isLeftClick(action) }, "left");
      if (lock) throw new Error(lock);
      if (!P.unpackButton(held.rows[i])) throw new Error("That button holds something set in ATK HUB; SYNQ leaves it alone.");
      const row = P.packButton(action);
      if (row.join() === held.rows[i].join()) return state();
      await wire.writeRow(P.keyRowAddress(i), row);
      held.rows[i] = row;
      const after = mouseButtonsProblem(held.rows.map((r, n) => ({ id: P.BUTTONS[n].id, leftClick: isLeftClick(P.unpackButton(r)) })), "left");
      if (after) throw new Error(after);
      d.refresh().catch(() => undefined);
      return state();
    },
    async undoAll() {
      if (!held) throw new Error("Start button changes first.");
      for (let i = 0; i < held.rows.length; i++) {
        if (held.rows[i].join() === held.original[i].join()) continue;
        await wire.writeRow(P.keyRowAddress(i), held.original[i]);
        held.rows[i] = [...held.original[i]];
      }
      d.refresh().catch(() => undefined);
      return state();
    },
    async end() {
      held = null;
      await gate.revoke("remap");
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Factory reset
  // ---------------------------------------------------------------------------------------------
  /** Every row SYNQ writes, as read before the reset: the settings backup and the restore list. */
  let saved: { path: string; rows: { address: number; bytes: number[]; key: boolean }[] } | null = null;

  const backupAll = async (): Promise<string> => {
    const rows: { address: number; bytes: number[]; key: boolean }[] = [];
    const sys = await wire.read(P.ADDR.system, P.SYSTEM_LENGTH);
    for (let i = 0; i < P.PAW3955_MAX_STAGES; i++) rows.push({ address: P.ADDR.paw3955Dpi + i * P.PAW3955_STAGE_LENGTH, bytes: await wire.read(P.ADDR.paw3955Dpi + i * P.PAW3955_STAGE_LENGTH, P.PAW3955_STAGE_LENGTH), key: false });
    rows.push({ address: P.ADDR.system, bytes: sys, key: false });
    rows.push({ address: P.ADDR.liftOff, bytes: await wire.read(P.ADDR.liftOff, 2), key: false });
    rows.push({ address: P.ADDR.function, bytes: await wire.read(P.ADDR.function, P.FUNCTION_LENGTH), key: false });
    rows.push({ address: P.ADDR.performance, bytes: await wire.read(P.ADDR.performance, P.PERFORMANCE_LENGTH), key: false });
    for (let i = 0; i < P.KEY_ROW.count; i++) rows.push({ address: P.keyRowAddress(i), bytes: await wire.read(P.keyRowAddress(i), P.KEY_ROW.length), key: true });
    const angle = await wire.read(P.ADDR.angle, 4);
    const path = await d.save(
      RESET_PREFIX,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          note: "Everything SYNQ can write to this mouse, as it was before a factory reset. 'Restore my settings' puts these rows back.",
          device: `ATK ${d.deviceName}`,
          cidMid: `${d.cid},${d.mid}`,
          firmware: d.firmware,
          receiverFirmware: d.receiverFirmware,
          rows: rows.map((r) => ({ address: `0x${r.address.toString(16).padStart(4, "0")}`, bytes: hex(r.bytes), kind: r.key ? "button" : "setting" })),
          angle: hex(angle),
        },
        null,
        1,
      ),
    );
    saved = { path, rows };
    return path;
  };

  const reset: ResetApi = {
    wipes: [
      "Sensitivity steps, polling rate, lift-off distance, debounce and the other sensor settings go back to the factory values.",
      "Button changes go back to the factory buttons.",
      "Anything you set up in ATK HUB (lighting, macros) may go back to factory too.",
    ],
    backup: backupAll,
    async reset(confirmation) {
      if (!d.writable) throw new Error("This mouse can't be changed from SYNQ yet, so it can't be reset from here either.");
      const unconfirmed = confirmationProblem("reset", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      // The reset never runs without a fresh full backup on disk first.
      const backupPath = await backupAll();
      await gate.grant("reset", confirmation);
      try {
        await wire.exchange(P.buildRestoreFactory(), (r) => r[0] === 0x09, 2500).catch((e) => {
          if (!(e instanceof NoReply)) throw e; // a reset mouse may restart before it answers
        });
        await wait(1500);
      } finally {
        await gate.revoke("reset");
      }
      await d.refresh().catch(() => undefined);
      return { backupPath };
    },
    canRestore: () => saved !== null,
    async restore(confirmation) {
      if (!saved) throw new Error("There is no saved copy to put back.");
      if (!confirmation.acknowledged) throw new Error("Restoring needs your confirmation.");
      const rows = saved.rows;
      await gate.grant("remap", { acknowledged: true });
      try {
        // DPI steps, then the system row (rate, step count, active step), then the rest, as ATK HUB orders them; buttons last.
        for (const r of rows) {
          const current = await wire.read(r.address, r.bytes.length);
          if (current.join() !== r.bytes.join()) await wire.writeRow(r.address, r.bytes);
        }
      } finally {
        await gate.revoke("remap");
      }
      await d.refresh().catch(() => undefined);
    },
  };

  // ---------------------------------------------------------------------------------------------
  // What the card shows
  // ---------------------------------------------------------------------------------------------
  const why = !d.writable ? "SYNQ hasn't checked this mouse on this connection yet, so it only reads it." : "";
  const features = withFeatures(
    noFeatures("SYNQ has no documented commands for this on the X1."),
    {
      pair: d.wireless && d.writable
        ? { available: true, source: `${SOURCE} (SetWirelessDonglePair / GetWirelessDonglePairResult)` }
        : { available: false, source: "", why: d.wireless ? why : "Pairing is for the 8K receiver. This mouse is on its cable." },
      remap: d.writable ? { available: true, source: `${SOURCE} (button rows key0..key5)` } : { available: false, source: "", why },
      macros: { available: false, source: "", why: "The X1's macro memory isn't documented well enough in SYNQ's sources to write it safely, so macros stay in ATK HUB." },
      calibrate: { available: false, source: "", why: "This mouse has no switch calibration." },
      reset: d.writable ? { available: true, source: `${SOURCE} (RestoreFactory)` } : { available: false, source: "", why },
    },
  );

  return {
    deviceName: d.deviceName,
    kind: "mouse",
    gate,
    features,
    firmware: firmwareInfo(
      "ATK",
      [
        { part: "Mouse", version: d.firmware ?? "" },
        { part: "8K receiver", version: d.receiverFirmware ?? "" },
      ],
      "Updates go through ATK HUB. SYNQ never flashes firmware.",
    ),
    pair: features.pair.available ? pair : undefined,
    buttons: features.remap.available ? buttons : undefined,
    reset: features.reset.available ? reset : undefined,
    refreshed: undefined,
  };
}

