// Read-only check of OpenMouse's drivers on real mice, through SYNQ's own HID bridge (src/hid.rs
// via the hid_pipe example), with no window. It asks which driver OpenMouse's registry and SYNQ's
// lazy registry pick for each plugged-in interface, then runs that driver's readStatus() and prints
// what it read. Every output report passes a read-only guard first: anything that isn't a known
// read is refused and logged, and feature-report writes don't exist here at all.
//
//   cd src-tauri && cargo build --example hid_pipe && cd ..
//   node scripts/openmouse-readonly-check.ts [vid:pid ...]      (default: 046d:c54d 373b:1278)
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSupportedClient } from "@openmouse/protocol/drivers";
import { findDriver } from "../src/lib/openmouse/registry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["046d:c54d", "373b:1278"]);
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const id4 = (n: number) => n.toString(16).padStart(4, "0");

// ---- the pipe
const pipe = spawn(join(root, "src-tauri/target/debug/examples/hid_pipe.exe"), [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
const pending = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();
const listeners = new Map<string, Set<(e: HIDInputReportEvent) => void>>();
const inputHooks: ((key: string, reportId: number, data: number[]) => void)[] = [];
let seq = 1;
createInterface({ input: pipe.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.event === "input") {
    for (const h of inputHooks) h(m.key, m.reportId, m.data);
    const dev = devices.find((d) => d.key === m.key);
    const event = { device: dev, reportId: m.reportId, data: new DataView(Uint8Array.from(m.data).buffer) } as unknown as HIDInputReportEvent;
    for (const l of listeners.get(m.key) ?? []) l(event);
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if ("err" in m) p.err(new Error(m.err));
  else p.ok(m.ok);
});
function rpc<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const id = seq++;
  return new Promise<T>((ok, err) => {
    pending.set(id, { ok: ok as (v: unknown) => void, err });
    pipe.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
  });
}

// ---- read-only guard
const log: string[] = [];
const note = (s: string) => {
  log.push(s);
  console.log(s);
};
/** ATK (0x55-framed, report 8): command bytes that only read. */
const ATK_READS = new Set([0x03, 0x04, 0x08, 0x0e, 0x10, 0x12, 0x1d]);
/** HID++ 2.0: functions that only read, per feature id. Unknown features and functions are refused. */
const HIDPP_READS: Record<number, number[]> = {
  0x0000: [0, 1], // root: getFeature, ping
  0x0001: [0, 1], // feature set
  0x0003: [0, 1, 2], // firmware info
  0x0005: [0, 1, 2], // device name and type
  0x0007: [0, 1, 2], // friendly name (reads)
  0x1000: [0, 1], // battery status
  0x1001: [0], // battery voltage
  0x1004: [0, 1], // unified battery
  0x1f20: [0], // ADC measurement
  0x2201: [0, 1, 2], // adjustable DPI: count, list, get
  0x2202: [0, 1, 2], // extended DPI: count, capabilities, ranges
  0x8060: [0, 1], // report rate: list, get
  0x8061: [0, 1, 2], // extended report rate: reads
  0x8100: [0, 2, 4, 5, 0x0b], // onboard profiles: description, getMode, getCurrentProfile, memoryRead, getDpiIndex
  0x1b04: [0, 1, 2], // reprogrammable controls: reads
};
const featureMap = new Map<string, Map<number, number>>(); // key -> index -> feature id
const askedFeature = new Map<string, number>(); // key:devIdx -> feature id asked of root
inputHooks.push((key, reportId, d) => {
  if ((reportId === 0x10 || reportId === 0x11) && d[1] === 0x00 && d[2] >> 4 === 0) {
    const asked = askedFeature.get(`${key}:${d[0]}`);
    if (asked !== undefined && d[3]) featureMap.get(key)?.set(d[3], asked);
  }
});
function guard(dev: PipeDevice, reportId: number, d: Uint8Array): string | null {
  if (dev.vendorId === 0x373b) {
    if (reportId !== 0x08) return `ATK report 0x${reportId.toString(16)} isn't a known read`;
    return ATK_READS.has(d[0]) ? null : `ATK command 0x${d[0].toString(16)} isn't a known read`;
  }
  if (dev.vendorId === 0x046d) {
    if (reportId !== 0x10 && reportId !== 0x11) return `Logitech report 0x${reportId.toString(16)} isn't HID++`;
    const [devIdx, feat, fnSw] = d;
    if (feat >= 0x80) return feat === 0x81 || feat === 0x83 ? null : `HID++ 1.0 sub-id 0x${feat.toString(16)} (register write or other)`;
    if (feat === 0x00 && fnSw >> 4 === 0) {
      askedFeature.set(`${dev.key}:${devIdx}`, (d[3] << 8) | d[4]);
      return null;
    }
    const fid = feat === 0 ? 0 : featureMap.get(dev.key)?.get(feat);
    if (fid === undefined) return `HID++ feature index ${feat} isn't known yet`;
    return HIDPP_READS[fid]?.includes(fnSw >> 4) ? null : `HID++ feature 0x${fid.toString(16)} function ${fnSw >> 4} isn't on the read list`;
  }
  return "only the target mice are checked";
}

// ---- a WebHID device over the pipe
interface Summary {
  key: string;
  vendorId: number;
  productId: number;
  productName: string;
  collections: HIDCollectionInfo[];
}
class PipeDevice {
  key: string;
  vendorId: number;
  productId: number;
  productName: string;
  collections: HIDCollectionInfo[];
  opened = false;
  oninputreport = null;
  constructor(s: Summary) {
    this.key = s.key;
    this.vendorId = s.vendorId;
    this.productId = s.productId;
    this.productName = s.productName;
    this.collections = s.collections;
    featureMap.set(s.key, new Map());
  }
  async open() {
    if (!this.opened) await rpc("open", { key: this.key });
    this.opened = true;
  }
  async close() {
    if (this.opened) await rpc("close", { key: this.key });
    this.opened = false;
  }
  async forget() {
    await this.close();
  }
  async sendReport(reportId: number, data: BufferSource) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const refused = guard(this, reportId, bytes);
    note(`  ${refused ? "REFUSED" : "out"} ${id4(this.vendorId)}:${id4(this.productId)} [${reportId.toString(16)}] ${hex(bytes.slice(0, 20))}${refused ? `  (${refused})` : ""}`);
    if (refused) throw new Error(`read-only check refused: ${refused}`);
    await rpc("send", { key: this.key, reportId, data: Array.from(bytes) });
  }
  async sendFeatureReport(reportId: number) {
    note(`  REFUSED feature write [${reportId.toString(16)}]`);
    throw new Error("read-only check: no feature-report writes");
  }
  async receiveFeatureReport(reportId: number) {
    const bytes = await rpc<number[]>("getFeature", { key: this.key, reportId });
    note(`  feature in [${reportId.toString(16)}] ${hex(bytes.slice(0, 20))}`);
    return new DataView(Uint8Array.from(bytes).buffer);
  }
  addEventListener(type: string, l: (e: HIDInputReportEvent) => void) {
    if (type !== "inputreport") return;
    if (!listeners.has(this.key)) listeners.set(this.key, new Set());
    listeners.get(this.key)!.add(l);
  }
  removeEventListener(type: string, l: (e: HIDInputReportEvent) => void) {
    listeners.get(this.key)?.delete(l);
  }
  dispatchEvent() {
    return true;
  }
}
// The drivers use window.setTimeout and friends, as in a browser.
(globalThis as Record<string, unknown>).window ??= globalThis;
let devices: PipeDevice[] = [];
Object.defineProperty(globalThis.navigator, "hid", {
  configurable: true,
  value: {
    getDevices: async () => devices,
    requestDevice: async () => devices,
    addEventListener() {},
    removeEventListener() {},
  },
});

const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms))]);
const brief = (s: Record<string, unknown>) => {
  const keep = ["brand", "name", "dpi", "dpiStages", "activeDpiStage", "pollingRateHz", "supportedPollingRates", "liftOffDistance", "motionSync", "angleSnapping", "rippleControl", "debounceMs", "sleepTimeout", "batteryPercent", "batteryState", "connectionType", "connectionDetail", "deviceMode", "firmware", "ui", "activeProfile"];
  return Object.fromEntries(keep.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
};

try {
  const list = await rpc<Summary[]>("list");
  devices = list.map((s) => new PipeDevice(s));
  for (const t of targets) {
    const ifaces = devices.filter((d) => `${id4(d.vendorId)}:${id4(d.productId)}` === t);
    note(`\n== ${t}: ${ifaces.length ? `${ifaces.length} interface(s) listed by the bridge` : "not plugged in (or not allowed)"}`);
    let read = false;
    for (const d of ifaces) {
      const cols = d.collections.map((c) => `${id4(c.usagePage)}:${id4(c.usage)} in[${c.inputReports.map((r) => r.reportId).join(",")}] out[${c.outputReports.map((r) => r.reportId).join(",")}] feat[${c.featureReports.map((r) => r.reportId).join(",")}]`);
      const om = createSupportedClient(d as unknown as HIDDevice);
      const lazy = await findDriver(d as unknown as HIDDevice);
      note(`  interface ${d.key} "${d.productName}"\n    collections: ${cols.join("; ")}\n    createSupportedClient: ${om ? om.constructor.name : "none"} | SYNQ lazy registry: ${lazy ? `${lazy.cls} (${lazy.brand})` : "none"}`);
      if (!om || read) continue;
      read = true;
      try {
        const status = await timeout((om as unknown as { readStatus(): Promise<Record<string, unknown>> }).readStatus(), 12000);
        note(`  readStatus: ${JSON.stringify(brief(status))}`);
      } catch (e) {
        note(`  readStatus failed: ${String(e).replace(/^Error: /, "")}`);
      }
      await (om as unknown as { close(): Promise<void> }).close().catch(() => undefined);
    }
  }
} finally {
  for (const d of devices) await d.close().catch(() => undefined);
  pipe.stdin.write(JSON.stringify({ id: 0, op: "quit" }) + "\n");
  pipe.stdin.end();
  setTimeout(() => pipe.kill(), 1500).unref();
}
