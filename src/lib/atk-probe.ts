// Is the ATK mouse on and answering? The two reads are in atk-wire.ts (probeAtkOn); this hands them
// the devices the Rust bridge lists and tells them when the ATK panel is using the receiver. Small on
// purpose: it loads the frame code, not the whole ATK service.
import { installTauriHid } from "./tauri-hid";
import { sessionHeld } from "./device-session";
import { probeAtkOn } from "./atk-wire";

export async function probeAtk(ms: number): Promise<boolean> {
  await installTauriHid();
  return probeAtkOn(await navigator.hid.getDevices(), ms, () => sessionHeld("mouse.atk"));
}
