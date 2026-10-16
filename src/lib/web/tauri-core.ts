// The website's stand-in for @tauri-apps/api/core (vite.web.config.ts aliases the package to this file).
// The keyboard (Falchion), X68 HE, Logitech and ATK services call the desktop app's commands through
// `invoke`; here the same command names are answered from WebHID (through the guarded proxies, so the
// guard sees every report) and from the browser store. A command the website doesn't have (EQ, the
// system sound output, Advanced grants, the desktop updater) rejects with a plain sentence.
//
// Only the commands the services really use are here, named as in src-tauri/src/lib.rs.
//
// With SYNQ Helper connected (src/lib/web/helper.ts), the device commands, the EQ and the Advanced
// grants go to the helper instead, which answers them with the desktop app's own Rust code and guards; so do the
// monitors, webcams and Wi-Fi lights, which a browser can't reach at all (without the helper: "needs SYNQ Helper").
import { WEB_DESKTOP_ONLY, WEB_HELPER_ONLY } from "../runtime";
import { emit } from "./tauri-event";
import { HELPER_COMMANDS, helperCall, helperReady, helperSettled } from "./helper";
import type { GuardedHidDevice } from "./proxy";

type Args = Record<string, unknown> | undefined;

const keys = new WeakMap<GuardedHidDevice, string>();
const byKey = new Map<string, GuardedHidDevice>();
const taps = new Map<string, () => void>();
let next = 1;

const keyOf = (d: GuardedHidDevice): string => {
  let k = keys.get(d);
  if (!k) {
    keys.set(d, (k = `w${next++}`));
    byKey.set(k, d);
  }
  return k;
};

const device = (args: Args): GuardedHidDevice => {
  const d = byKey.get(String(args?.key));
  if (!d) throw new Error("That device isn't connected any more. Replug it and try again.");
  return d;
};

const bytes = (v: unknown): Uint8Array<ArrayBuffer> => Uint8Array.from(v as ArrayLike<number>);
const store = async () => (await import("./store")).browserStore();
const hid = () => import("./hid");
const hubs = () => import("./hubs");
const lampArrays = () => import("./lamparrays");

/** Devices the last `hid_list` showed that are gone now: their services hear "hid-lost". */
let lastKeys = new Set<string>();

async function hidList() {
  const { guardedDevices } = await hid();
  const list = await guardedDevices();
  const now = new Set<string>();
  const out = list.map((d) => {
    const key = keyOf(d);
    now.add(key);
    return {
      key,
      vendorId: d.vendorId,
      productId: d.productId,
      productName: d.productName,
      collections: d.collections.map((c) => ({ usagePage: c.usagePage, usage: c.usage, interface: -1 })),
    };
  });
  for (const k of lastKeys) if (!now.has(k)) emit("hid-lost", { key: k });
  lastKeys = now;
  return out;
}

const handlers: Record<string, (a: Args) => Promise<unknown> | unknown> = {
  hid_list: hidList,
  async hid_open(a) {
    const d = device(a);
    const key = String(a?.key);
    await d.open();
    if (!taps.has(key)) {
      const tap = (e: { reportId: number; data: DataView }) => emit("hid-input", { key, reportId: e.reportId, data: Array.from(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)) });
      d.addEventListener("inputreport", tap);
      taps.set(key, () => d.removeEventListener("inputreport", tap));
    }
  },
  async hid_close(a) {
    const key = String(a?.key);
    taps.get(key)?.();
    taps.delete(key);
    await byKey.get(key)?.close();
  },
  hid_send_report: (a) => device(a).sendReport(Number(a?.reportId), bytes(a?.data)),
  hid_send_feature_report: (a) => device(a).sendFeatureReport(Number(a?.reportId), bytes(a?.data)),
  hid_send_report_to: (a) => device(a).sendReportTo(Number(a?.usagePage), Number(a?.usage), Number(a?.reportId), bytes(a?.data)),
  async hid_receive_feature_report(a) {
    const v = await device(a).receiveFeatureReport(Number(a?.reportId));
    return Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  },
  devices_list: async () => (await import("./devices")).webDevicesList(),
  // USB RGB hubs: their vendor collection, every report through the hub guard (src/lib/web/hubs.ts).
  rgbhub_write: async (a) => (await hubs()).hubWrite(String(a?.vid), String(a?.pid), Number(a?.reportId), a?.data as number[]),
  rgbhub_read: async (a) => (await hubs()).hubRead(String(a?.vid), String(a?.pid), Number(a?.timeoutMs)),
  rgbhub_close: async (a) => (await hubs()).hubClose(String(a?.vid), String(a?.pid)),
  // Dynamic Lighting devices: the HID LampArray standard, every report through its guard (src/lib/web/lamparrays.ts).
  lamparray_watch: async (a) => (a?.on ? (await lampArrays()).lampArrayList() : []),
  lamparray_info: async (a) => (await lampArrays()).lampArrayInfo(String(a?.id)),
  lamparray_set: async (a) => (await lampArrays()).lampArraySet(String(a?.id), a?.colors as number[]),
  lamparray_close: async (a) => (await lampArrays()).lampArrayClose(String(a?.id)),

  // Backups, logs, settings copies: this browser's storage.
  mouse_backup_save: async (a) => (await store()).saveBackup(String(a?.prefix ?? "logitech-profiles"), String(a?.json)),
  mouse_log: async (a) => (await store()).log(`log-${a?.prefix}`, a?.lines as string[]),
  kb_backup_save: async (a) => (await store()).saveBackup(String(a?.prefix ?? "keyboard"), String(a?.json)),
  pad_backup_save: async (a) => (await store()).saveBackup(String(a?.prefix ?? "controller"), String(a?.json)),
  display_backup_save: async (a) => (await store()).saveBackup(String(a?.prefix ?? "display"), String(a?.json)),
  kb_log: async (a) => (await store()).log(`log-${a?.prefix}`, a?.lines as string[]),
  keyboard_log: async (a) => (await store()).log(`log-keyboard-${a?.serial}`, a?.lines as string[]),
  keyboard_state_load: async (a) => (await store()).loadState(`keyboard-${a?.serial}`),
  keyboard_state_save: async (a) => (await store()).saveState(`keyboard-${a?.serial}`, String(a?.json)),
  // "Keep your feel": one document, in the same table as the other settings copies (so "Download backup" has it).
  feel_load: async () => (await store()).loadState("feel"),
  feel_save: async (a) => (await store()).saveState("feel", String(a?.json)),
  kb_definition_load: async (a) => (await store()).loadDefinition(String(a?.key)),
  kb_definition_save: async (a) => (await store()).saveDefinition(String(a?.key), String(a?.json)),

  // The desktop app's own housekeeping: nothing to do in a browser.
  page_busy: () => undefined,
  memory_trim: () => undefined,
};

export async function invoke<T>(cmd: string, args?: Args): Promise<T> {
  if (HELPER_COMMANDS.has(cmd)) {
    await helperSettled();
    if (helperReady()) return helperCall<T>(cmd, args);
  }
  const h = handlers[cmd];
  if (!h) throw new Error(HELPER_COMMANDS.has(cmd) ? WEB_HELPER_ONLY : WEB_DESKTOP_ONLY);
  return (await h(args)) as T;
}
