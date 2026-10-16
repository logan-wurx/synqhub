// VIA / Vial Advanced actions: keys beyond the basic ones, macros, and a keymap + macro reset. Each runs
// behind the panel's confirmation (src/lib/advanced/core.ts), through the same guard as every other frame
// (guard.ts, mirrored by src-tauri/src/hid.rs `via_frame_allowed_with`):
//   - a backup of the whole keymap and the macro buffer is saved BEFORE the token is taken, so before the
//     first changing frame;
//   - every key write is read back; "Undo all" writes the saved keys back;
//   - bootloader, reboot and EEPROM-clear keys, tap dance and custom codes are never written, and a key that
//     holds one is never overwritten (it couldn't be put back);
//   - a keyboard always keeps its way back (src/lib/advanced/lockout.ts);
//   - the EEPROM reset (0x0A), the bootloader jump (0x0B) and the bulk keymap write (0x13) stay refused
//     whatever is granted.
// Sources: VIA's raw-HID protocol as implemented in QMK (quantum/via.c, quantum/dynamic_keymap.c), keycodes
// per QMK's quantum_keycodes.h in its two encodings, vial-qmk for Vial boards.
// No Tauri, no React.
import { confirmationProblem, type AdvancedGate, type KeycodeScheme } from "../../advanced/core.ts";
import { firmwareInfo } from "../../advanced/firmware.ts";
import { keymapProblem } from "../../advanced/lockout.ts";
import {
  noFeatures,
  withFeatures,
  type AdvancedPanel,
  type KeyChoice,
  type KeymapAdvancedState,
  type KeymapApi,
  type MacroSlot,
  type MacrosApi,
  type MacrosState,
  type ResetApi,
} from "../../advanced/types.ts";
import type { KbStore } from "../types.ts";
import { MACRO_LIMIT } from "./guard.ts";
import { advancedKeycodeOk, keycodeRefusal, layerKeycodes, macroKeycode } from "./keycode-safety.ts";
import { ASSIGNABLE, keycodeLabel } from "./keycodes.ts";
import { joinMacros, macroToText, splitMacros, textToMacro } from "./macro-codec.ts";
import type { ViaClient } from "./protocol.ts";

export interface ViaAdvancedSource {
  client: ViaClient;
  gate: AdvancedGate;
  /** Where backups go; without one nothing here is offered. */
  store: KbStore | undefined;
  deviceName: string;
  brand: "VIA" | "Vial";
  vendorId: number;
  productId: number;
  scheme: KeycodeScheme;
  protocolLine: string;
  firmware: readonly string[];
  /** The matrix and the key indexes the layout has; null when the board's layout is unknown. */
  matrix(): { rows: number; cols: number; keys: readonly number[] } | null;
  layers(): number;
  macros(): { count: number; bytes: number };
  /** Reads the keyboard again so the panel shows what it holds now. */
  reload(): Promise<void>;
}

const SOURCE_KEYS = "VIA protocol (QMK quantum/via.c, dynamic keymap) with QMK's keycode table";
const SOURCE_MACROS = "VIA protocol macro buffer (QMK quantum/dynamic_keymap.c)";
const SOURCE_RESET = "VIA protocol dynamic keymap reset (0x06) and macro reset (0x10); the EEPROM reset stays blocked";

const hex4 = (n: number) => n.toString(16).padStart(4, "0");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "keyboard";

const writable = (code: number, scheme: KeycodeScheme) => code <= 0x00ff || advancedKeycodeOk(code, scheme);

export function viaAdvanced(src: ViaAdvancedSource): AdvancedPanel {
  const { client, gate } = src;
  const prefix = `kb-${slug(src.brand)}-${slug(src.deviceName)}`;
  const m = src.matrix();
  const macroInfo = src.macros();

  /** The whole keymap as the keyboard holds it right now: codes[layer][row * cols + col]. */
  const readCells = async () => {
    const mx = src.matrix();
    if (!mx) throw new Error("This keyboard's layout isn't known, so its keys can't be read.");
    return client.readKeymap(src.layers(), mx.rows, mx.cols);
  };
  const readMacroBuffer = async () => {
    const info = src.macros();
    return info.bytes ? Array.from(await client.readMacroBuffer(info.bytes)) : [];
  };
  const header = (what: string) => ({
    savedAt: new Date().toISOString(),
    note: what,
    device: { vendorId: hex4(src.vendorId), productId: hex4(src.productId), name: src.deviceName },
    protocol: src.protocolLine,
    keycodeScheme: src.scheme,
  });
  const save = async (what: string, name: string, cells: number[][], macros: number[]) => {
    if (!src.store) throw new Error("There is nowhere to keep a backup, so SYNQ won't change this keyboard.");
    const mx = src.matrix();
    return src.store.saveBackup(
      `${prefix}-${name}`,
      JSON.stringify({ ...header(what), matrix: mx ? { rows: mx.rows, cols: mx.cols } : null, layers: cells.length, keymap: cells, macroBuffer: macros }, null, 1),
    );
  };

  // ---------------------------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------------------------
  let keys: { original: number[][]; current: number[][]; backupPath: string } | null = null;

  const choices = (): KeyChoice[] => {
    const out: KeyChoice[] = ASSIGNABLE.map((a) => ({ code: a.code, label: a.label, group: a.group }));
    const layers = src.layers();
    for (let n = 0; n < layers; n++) {
      const k = layerKeycodes(n, src.scheme);
      out.push({ code: k.mo, label: `Hold layer ${n}`, group: "Layers" }, { code: k.tg, label: `Toggle layer ${n}`, group: "Layers" }, { code: k.to, label: `Go to layer ${n}`, group: "Layers" });
    }
    for (let n = 0; n < Math.min(macroInfo.count, 16); n++) out.push({ code: macroKeycode(n, src.scheme), label: `Macro ${n}`, group: "Macros" });
    return out.filter((c) => writable(c.code, src.scheme));
  };

  const keysState = (): KeymapAdvancedState => {
    const k = keys!;
    const mx = src.matrix()!;
    const cell = (layer: number, i: number) => k.current[layer][i] ?? 0;
    return {
      layers: k.current.length,
      codes: k.current.map((_, layer) => Object.fromEntries(mx.keys.map((i) => [i, cell(layer, i)]))),
      changed: k.current.map((l, layer) => mx.keys.filter((i) => (l[i] ?? 0) !== (k.original[layer][i] ?? 0))),
      backupPath: k.backupPath,
      choices: choices(),
    };
  };

  const asLayerMaps = (cells: number[][], keysList: readonly number[]) => cells.map((l) => Object.fromEntries(keysList.map((i) => [i, l[i] ?? 0])));

  const keyProblem = (layer: number, key: number, code: number): string | null => {
    const mx = src.matrix();
    if (!mx || !keys) return "Start key changes first.";
    if (!Number.isInteger(layer) || layer < 0 || layer >= keys.current.length) return `This keyboard has layers 0 to ${keys.current.length - 1}.`;
    if (!mx.keys.includes(key)) return "That key isn't on this keyboard's layout.";
    if (!Number.isInteger(code) || code < 0 || code > 0xffff) return "That isn't a key code.";
    if (!writable(code, src.scheme)) return keycodeRefusal(code, src.scheme);
    const now = keys.current[layer][key] ?? 0;
    if (!writable(now, src.scheme)) return "This key holds a special key (boot, reboot or reset). SYNQ leaves it alone, because it couldn't put it back.";
    const macroIndex = src.scheme === "current" ? code - 0x7700 : code - 0x5f12;
    if (code >= (src.scheme === "current" ? 0x7700 : 0x5f12) && macroIndex < 0x80 && macroIndex >= macroInfo.count) return `This keyboard has ${macroInfo.count} macros (0 to ${macroInfo.count - 1}).`;
    const next = keys.current.map((l, i) => (i === layer ? l.map((c, n) => (n === key ? code : c)) : l));
    return keymapProblem(asLayerMaps(next, mx.keys), mx.keys, src.scheme);
  };

  const keymap: KeymapApi = {
    async begin(confirmation) {
      const unconfirmed = confirmationProblem("remap", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      const cells = await readCells();
      const backupPath = await save("The keymap and macros before key changes from the Advanced card.", "keys", cells, await readMacroBuffer());
      await gate.grant("remap", confirmation, { scheme: src.scheme });
      keys = { original: cells.map((l) => [...l]), current: cells.map((l) => [...l]), backupPath };
      return keysState();
    },
    async set(layer, key, code) {
      const problem = keyProblem(layer, key, code);
      if (problem) throw new Error(problem);
      const k = keys!;
      const mx = src.matrix()!;
      const row = Math.floor(key / mx.cols);
      const col = key % mx.cols;
      await client.setKeycode(layer, row, col, code);
      const got = await client.getKeycode(layer, row, col);
      k.current[layer][key] = got;
      if (got !== code) throw new Error(`The keyboard kept 0x${hex4(got)} instead of 0x${hex4(code)}.`);
      return keysState();
    },
    async undoAll() {
      if (!keys) throw new Error("Start key changes first.");
      const k = keys;
      const mx = src.matrix()!;
      for (let layer = 0; layer < k.current.length; layer++) {
        for (let i = 0; i < k.current[layer].length; i++) {
          const want = k.original[layer][i] ?? 0;
          if ((k.current[layer][i] ?? 0) === want) continue;
          // Only keys SYNQ changed come back here, and it only changes keys whose old code it can write.
          await client.setKeycode(layer, Math.floor(i / mx.cols), i % mx.cols, want);
          k.current[layer][i] = want;
        }
      }
      return keysState();
    },
    async end() {
      keys = null;
      await gate.revoke("remap");
    },
    label: (code) => keycodeLabel(code, src.scheme),
    problem: keyProblem,
  };

  // ---------------------------------------------------------------------------------------------
  // Macros
  // ---------------------------------------------------------------------------------------------
  let macros: { original: number[]; current: number[]; backupPath: string } | null = null;

  const macroSlots = (buffer: readonly number[]): MacroSlot[] =>
    splitMacros(buffer, macroInfo.count).map((bytes, index) => {
      const text = macroToText(bytes);
      return { index, text: text ?? "", bytes: bytes.length, editable: text !== null };
    });

  const macrosState = (): MacrosState => {
    const mm = macros!;
    return { slots: macroSlots(mm.current), capacity: macroInfo.bytes, used: usedBytes(mm.current, macroInfo.count), backupPath: mm.backupPath };
  };

  const check = (text: string) => {
    const e = textToMacro(text);
    return e.ok ? { bytes: e.bytes.length, error: null } : { bytes: 0, error: e.error };
  };

  /** Bytes the macros take: each run plus its closing 0x00. */
  const usedBytes = (buffer: readonly number[], count: number) => splitMacros(buffer, count).reduce((n, b) => n + b.length + 1, 0);

  const writeBuffer = async (from: readonly number[], to: readonly number[]) => {
    // Only the 28-byte pieces that differ are sent.
    const CH = 28;
    for (let at = 0; at < to.length; at += CH) {
      const a = from.slice(at, at + CH);
      const b = to.slice(at, at + CH);
      if (a.join() !== b.join()) await client.writeMacroBuffer(at, b);
    }
  };

  const macrosApi: MacrosApi = {
    async begin(confirmation) {
      const unconfirmed = confirmationProblem("macros", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      const buffer = await readMacroBuffer();
      if (!buffer.length || buffer.length > MACRO_LIMIT) throw new Error("This keyboard's macro memory can't be read here, so SYNQ won't change it.");
      const head = splitMacros(buffer, macroInfo.count).reduce((n, b) => n + b.length + 1, 0);
      if (buffer.slice(head).some((b) => b !== 0)) throw new Error("This keyboard keeps other data after its macros, so SYNQ leaves them alone.");
      const backupPath = await save("The macros before changes from the Advanced card.", "macros", await readCells().catch(() => []), buffer);
      await gate.grant("macros", confirmation);
      macros = { original: [...buffer], current: [...buffer], backupPath };
      return macrosState();
    },
    check,
    async save(index, text) {
      if (!macros) throw new Error("Start macro changes first.");
      if (!Number.isInteger(index) || index < 0 || index >= macroInfo.count) throw new Error(`This keyboard has macros 0 to ${macroInfo.count - 1}.`);
      const parts = splitMacros(macros.current, macroInfo.count);
      if (macroToText(parts[index]) === null) throw new Error("This macro holds actions SYNQ can't show, so it leaves it alone.");
      const e = textToMacro(text);
      if (!e.ok) throw new Error(e.error);
      parts[index] = e.bytes;
      const next = joinMacros(parts, macroInfo.bytes);
      if (!next) throw new Error(`That doesn't fit: the macros together take more than the ${macroInfo.bytes} bytes this keyboard keeps.`);
      await writeBuffer(macros.current, next);
      const back = Array.from(await client.readMacroBuffer(macroInfo.bytes));
      macros.current = back;
      if (back.join() !== next.join()) throw new Error("The keyboard didn't keep the macro as written.");
      return macrosState();
    },
    async undoAll() {
      if (!macros) throw new Error("Start macro changes first.");
      await writeBuffer(macros.current, macros.original);
      macros.current = Array.from(await client.readMacroBuffer(macroInfo.bytes));
      return macrosState();
    },
    async end() {
      macros = null;
      await gate.revoke("macros");
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------------------------
  let kept: { path: string; cells: number[][]; macros: number[] } | null = null;

  const backupAll = async () => {
    const cells = await readCells();
    const buffer = await readMacroBuffer();
    const path = await save("Every key and macro as they were before a factory reset from the Advanced card. 'Restore my settings' writes them back.", "before-reset", cells, buffer);
    kept = { path, cells, macros: buffer };
    return path;
  };

  const resetApi: ResetApi = {
    wipes: [
      "Every key on every layer goes back to the keymap the keyboard's firmware was built with.",
      "Every macro is erased.",
      "Lighting and the keyboard's other settings are not touched.",
    ],
    backup: backupAll,
    async reset(confirmation) {
      const unconfirmed = confirmationProblem("reset", confirmation);
      if (unconfirmed) throw new Error(unconfirmed);
      const backupPath = await backupAll(); // always first, always fresh
      await gate.grant("reset", confirmation);
      try {
        await client.resetKeymap();
        if (src.macros().count) await client.resetMacros();
      } finally {
        await gate.revoke("reset");
      }
      await src.reload();
      return { backupPath };
    },
    canRestore: () => kept !== null,
    async restore(confirmation) {
      if (!kept) throw new Error("There is no saved copy to put back.");
      if (!confirmation.acknowledged) throw new Error("Restoring needs your confirmation.");
      const mx = src.matrix();
      if (!mx) throw new Error("This keyboard's layout isn't known, so its keys can't be put back.");
      const saved = kept;
      await gate.grant("remap", { acknowledged: true }, { scheme: src.scheme });
      await gate.grant("macros", { acknowledged: true });
      try {
        const now = await readCells();
        for (let layer = 0; layer < saved.cells.length; layer++) {
          for (let i = 0; i < saved.cells[layer].length; i++) {
            const want = saved.cells[layer][i] ?? 0;
            // A saved boot / reboot / reset key isn't written back; the factory keymap carries its own.
            if ((now[layer]?.[i] ?? 0) === want || !writable(want, src.scheme)) continue;
            await client.setKeycode(layer, Math.floor(i / mx.cols), i % mx.cols, want);
          }
        }
        if (saved.macros.length) {
          const current = Array.from(await client.readMacroBuffer(saved.macros.length));
          await writeBuffer(current, saved.macros);
        }
      } finally {
        await gate.revoke("remap");
        await gate.revoke("macros");
      }
      await src.reload();
    },
  };

  // ---------------------------------------------------------------------------------------------
  // The card
  // ---------------------------------------------------------------------------------------------
  const noStore = "There is nowhere to keep a backup here.";
  const noLayout = "This keyboard's layout isn't known, so its keys can't be read or changed.";
  const hasKeys = !!m && src.layers() > 0;
  const hasMacros = macroInfo.count > 0 && macroInfo.bytes > 0 && macroInfo.bytes <= MACRO_LIMIT;
  const features = withFeatures(noFeatures("VIA has no commands for this."), {
    pair: { available: false, source: "", why: "A wired VIA keyboard has no pairing commands. Wireless ones pair with keys on the board." },
    remap: hasKeys && src.store ? { available: true, source: SOURCE_KEYS } : { available: false, source: "", why: src.store ? noLayout : noStore },
    macros: hasMacros && src.store ? { available: true, source: SOURCE_MACROS } : { available: false, source: "", why: src.store ? (macroInfo.count ? "The macro memory is too large to read here." : "This keyboard has no macro memory.") : noStore },
    calibrate: { available: false, source: "", why: "VIA has no calibration commands. Analog boards calibrate in their maker's own app." },
    reset: hasKeys && src.store ? { available: true, source: SOURCE_RESET } : { available: false, source: "", why: src.store ? noLayout : noStore },
  });

  return {
    deviceName: src.deviceName,
    kind: "keyboard",
    gate,
    features,
    firmware: firmwareInfo("QMK", src.firmware.map((f) => ({ part: "Firmware", version: f.replace(/^Firmware\s+/i, "") })), "Keyboard firmware comes from the keyboard's maker. QMK Toolbox is the usual flasher. SYNQ never flashes."),
    keymap: features.remap.available ? keymap : undefined,
    macros: features.macros.available ? macrosApi : undefined,
    reset: features.reset.available ? resetApi : undefined,
  };
}
