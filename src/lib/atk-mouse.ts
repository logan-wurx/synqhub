// ATK mouse service: the Tauri side. It finds the X1 V2 Air+ receiver in the HID bridge's list (vendor
// collection FF02:0002 only) and hands it to the session (src/lib/atk-session.ts), which does the reading,
// the checked writes and the Advanced actions. In the browser preview there is no bridge: the session talks
// to a simulated X1 instead (src/lib/atk-sim.ts), through the same code.
import { invoke } from "@tauri-apps/api/core";
import { liveHardware } from "./backend";
import { installTauriHid } from "./tauri-hid";
import { pickAtkDevice } from "./atk-wire";
import { connectAtkDevice, type AtkSession } from "./atk-session";

export * from "./atk-session";

export async function connectAtk(): Promise<AtkSession | null> {
  if (!liveHardware) {
    // The browser preview talks to a simulated X1 through the very same code (src/lib/atk-sim.ts).
    const [{ simulateAtk }, { memoryStore }] = await Promise.all([import("./atk-sim"), import("./openmouse/store")]);
    const store = memoryStore();
    return connectAtkDevice(simulateAtk({ autoPairMs: 7000 }).device, store.saveBackup);
  }
  await installTauriHid();
  const device = pickAtkDevice(await navigator.hid.getDevices());
  if (!device) return null;
  // On the website the same call lands in the browser store (src/lib/web/tauri-core.ts).
  return connectAtkDevice(device, (prefix, json) => invoke<string>("mouse_backup_save", { json, prefix }));
}
