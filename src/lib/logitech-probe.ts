// Is a Logitech mouse on and answering? The ping itself is in logitech-ping.ts; this hands it the
// devices the Rust bridge lists and tells it when a panel is using the receiver.
import { installTauriHid } from "./tauri-hid";
import { sessionHeld } from "./device-session";
import { probeLogitechOn } from "./logitech-ping";

/** `pids` are the product ids (lower-case hex, as the device list has them) of the Logitech mice that are plugged in. */
export async function probeLogitech(pids: readonly string[], ms: number): Promise<boolean> {
  await installTauriHid();
  return probeLogitechOn(await navigator.hid.getDevices(), pids, ms, () => sessionHeld("mouse.logitech"));
}
