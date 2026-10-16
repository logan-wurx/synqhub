// Small helpers every driver's Advanced panel shares: a panel with information only (the card still shows
// the firmware and a link to the maker's updater), and a lock that keeps a panel's actions shut while the
// device is still read-only ("Allow changes" is off). Pure.
import { AdvancedGate } from "./core.ts";
import { firmwareInfo } from "./firmware.ts";
import { noFeatures, type AdvancedPanel } from "./types.ts";

/** A device whose driver has no Advanced actions: only its firmware and the updater link. */
export function infoOnlyPanel(o: { deviceName: string; kind: "mouse" | "keyboard"; brand: string; versions: readonly { part: string; version: string }[]; why: string; note?: string }): AdvancedPanel {
  return {
    deviceName: o.deviceName,
    kind: o.kind,
    gate: new AdvancedGate(`info:${o.deviceName}`),
    features: noFeatures(o.why),
    firmware: firmwareInfo(o.brand, o.versions, o.note ?? "Updates come from the maker's own app. SYNQ never flashes firmware."),
  };
}

/**
 * The same panel with every action refused while `locked()` returns a reason. Starting an action is
 * what takes the token, so refusing the start is enough: nothing else in a panel works without it.
 */
export function lockedPanel(panel: AdvancedPanel, locked: () => string | null): AdvancedPanel {
  const guard =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const why = locked();
      if (why) throw new Error(why);
      return fn(...a);
    };
  return {
    ...panel,
    pair: panel.pair && { ...panel.pair, run: guard(panel.pair.run.bind(panel.pair)) },
    buttons: panel.buttons && { ...panel.buttons, begin: guard(panel.buttons.begin.bind(panel.buttons)), set: panel.buttons.set.bind(panel.buttons), undoAll: panel.buttons.undoAll.bind(panel.buttons), end: panel.buttons.end.bind(panel.buttons) },
    keymap: panel.keymap && { ...panel.keymap, begin: guard(panel.keymap.begin.bind(panel.keymap)), set: panel.keymap.set.bind(panel.keymap), undoAll: panel.keymap.undoAll.bind(panel.keymap), end: panel.keymap.end.bind(panel.keymap), label: panel.keymap.label, problem: panel.keymap.problem },
    macros: panel.macros && { ...panel.macros, begin: guard(panel.macros.begin.bind(panel.macros)), save: panel.macros.save.bind(panel.macros), undoAll: panel.macros.undoAll.bind(panel.macros), end: panel.macros.end.bind(panel.macros), check: panel.macros.check },
    calibrate: panel.calibrate && { ...panel.calibrate, run: guard(panel.calibrate.run.bind(panel.calibrate)) },
    reset: panel.reset && {
      ...panel.reset,
      backup: guard(panel.reset.backup.bind(panel.reset)),
      reset: guard(panel.reset.reset.bind(panel.reset)),
      canRestore: panel.reset.canRestore.bind(panel.reset),
      restore: guard(panel.reset.restore.bind(panel.reset)),
    },
  };
}
