// The website's device list (the counterpart of src-tauri/src/devices.rs `list`): the granted WebHID
// devices grouped by vendor / product id, classified by the same rules (src/lib/web/policy.ts), and the
// availability verdict applied. Reading the browser's list sends nothing to any device.
import type { Connected } from "../backend";
import { classifyDevice, type CollectionInfo } from "./policy.ts";
import { availability } from "./availability.ts";
import { currentPlatform } from "./platform.ts";
import { rawGranted, installWebHid } from "./hid.ts";
import { setWebNotes, type WebNote } from "./notes.ts";

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

export async function webDevicesList(): Promise<Connected[]> {
  await installWebHid();
  const platform = currentPlatform();
  // One entry per vendor / product id, with every collection the browser lists and the first product string.
  const seen = new Map<string, { vid: number; pid: number; cols: CollectionInfo[]; name: string | null }>();
  for (const raw of await rawGranted()) {
    const key = `${raw.vendorId}:${raw.productId}`;
    const entry = seen.get(key) ?? { vid: raw.vendorId, pid: raw.productId, cols: [], name: null };
    for (const c of raw.collections) {
      const col = { usagePage: c.usagePage ?? 0, usage: c.usage ?? 0 };
      if (!entry.cols.some((x) => x.usagePage === col.usagePage && x.usage === col.usage)) entry.cols.push(col);
    }
    entry.name ??= raw.productName?.trim() || null;
    seen.set(key, entry);
  }
  const list: Connected[] = [];
  const notes: WebNote[] = [];
  for (const { vid, pid, cols, name } of seen.values()) {
    const id = `${hex4(vid)}:${hex4(pid)}`;
    const c = classifyDevice(vid, pid, cols, name);
    if (!c) {
      notes.push({
        id,
        name: name ?? id,
        kind: "unsupported",
        title: "Not driven by SYNQ yet",
        message: "The browser let this device in, but SYNQ has no driver for it. Nothing is sent to it.",
      });
      continue;
    }
    const a = availability({ vendorId: vid, productId: pid }, platform);
    if (a.status === "desktop" && !c.bootloader) {
      notes.push({ id, name: c.name, kind: "desktop", title: a.title, message: a.message });
      continue;
    }
    list.push({
      kind: c.kind,
      name: c.name,
      connection: c.connection,
      vid: c.vid,
      pid: c.pid,
      reported: c.reported,
      ...(c.generic ? { generic: true } : {}),
      ...(c.kb ? { kb: c.kb } : {}),
      ...(c.qmk ? { qmk: true } : {}),
      ...(c.bootloader ? { bootloader: true } : {}),
      ...(c.pad ? { pad: c.pad } : {}),
    });
  }
  setWebNotes(notes);
  return list;
}
