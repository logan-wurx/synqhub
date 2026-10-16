// MAGIC-REFINER X68 HE service: talks to the keyboard the way illumipc.com does (output and input
// reports, id 1, on the FF1B:0091 collection only) through the Tauri HID bridge. Same rules as the
// Falchion and ATK services, stricter where the protocol is unverified:
//   - read everything first; nothing is written until that read is complete and the layout is known;
//   - writes stay off until the user switches them on (first-run safety on a keyboard no one here has);
//   - before the first write of a session the full read is saved to app data
//     (%APPDATA%\com.logan.onboard\keyboard\x68he-<id>-backup-<time>.json, plus -original once);
//   - after every write the changed area is read back and compared;
//   - every frame passes checkFrame() (allowlist; reset, firmware and calibration are blocked) here and
//     again in Rust (hid.rs x68_frame_allowed);
//   - every report sent and received is logged to %APPDATA%\com.logan.onboard\keyboard\<id>-hid-log.txt.
// Protocol details: src/lib/x68he-protocol.ts and docs/keyboard-x68he/PROTOCOL.md.
import { rememberX68 } from "./profiles/state.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { liveHardware } from "./backend";
import * as P from "./x68he-protocol";
import { X68_LAYOUTS, identityFor, layoutForProduct, type X68Layout } from "./x68he-layout";
import { ILLUMIPC_COLLECTION, idKey, isIllumipcId } from "./illumipc/ids.ts";

export const X68_NAME = "MAGIC-REFINER X68 HE";
const LOG_DIR = "%APPDATA%\\com.logan.onboard\\keyboard";
const WRITES_KEY = "onboard.x68.writesEnabled";

const TIMING = {
  replyMs: 450,
  pagesMs: 2500,
  /** illumipc's idleTimeout: a multi-page read ends this long after the last page. */
  idleMs: 300,
  retries: 2,
  /** Pause after each fire-and-forget write (illumipc writeDelay 5 ms). */
  writeGapMs: 8,
  ackMs: 150,
  storingMs: 2000,
  profileQueryMs: 700,
  reconnectMs: 15000,
  reconnectStepMs: 400,
  pollSettleMs: 1200,
};

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export interface X68Info {
  /** Brand and model: "MAGIC-REFINER X68 HE", "Redragon K556RGB-M", "HE keyboard (<product code>)". */
  name: string;
  /** "Redragon", "MAGIC-REFINER", or "" when nobody told us (src/lib/x68he-layout.ts identityFor). */
  brand: string;
  /** "K556RGB-M", "X68 HE", or the product code. */
  model: string;
  /** The MAGIC-REFINER X68 HE family: its own photo and history in this app. */
  x68: boolean;
  /** The USB id it enumerated as ("2e3c:c365"; 2E3C:C366..C368 are gamepad personalities, 0416:7372 carries Redragon). */
  usbId: string;
  /** USB product string (Chrome showed "X68HE"). */
  usbName: string;
  product: string;
  productText: string;
  firmware: string;
  serial: string;
  /** File-name id: x68he-<serial or product>. */
  id: string;
}

export interface MacroSummary {
  slot: number;
  macroIndex: number;
  type: number;
  count: number;
  stepBytes: number;
}

export interface X68State {
  readAt: string;
  info: X68Info;
  status: P.Status | null;
  layout: X68Layout;
  layoutKnown: boolean;
  trigger: P.TriggerConfig | null;
  /** Per-key trigger settings by matrix index. */
  keys: Record<number, P.KeyTrigger>;
  /** 264 bytes: [top, bottom] per index, travel units. Null when the keyboard has no dead zones. */
  deadband: number[] | null;
  pollHz: number | null;
  /** Onboard profile 0..4, or null when the keyboard doesn't answer the profile query. */
  profile: number | null;
  light: { modes: P.LightModes; config: P.LightConfig } | null;
  keymap: { default: number[]; fn: number[] } | null;
  fnEditable: number[];
  advanced: P.AdvancedEntry[] | null;
  socd: { on: boolean; entries: P.SocdEntry[] } | null;
  switches: { list: number[]; perKey: Record<number, number> } | null;
  macros: MacroSummary[];
  /** Sections that failed to read. */
  problems: string[];
}

export interface X68View {
  state: X68State;
  link: "ok" | "reconnecting" | "lost";
  /** What is running right now ("Reading keys 12/68", "Saving lighting"). */
  busy: string | null;
  /** Writes are possible at all (complete read, known layout). */
  writable: boolean;
  readOnlyReason: string | null;
  /** The user switched changes on. */
  writesEnabled: boolean;
  backup: string | null;
  logFile: string;
}

export interface X68Session {
  view: X68View;
  subscribe(listener: (v: X68View) => void): () => void;
  setWritesEnabled(on: boolean): void;
  /** Per-key actuation / rapid trigger. Returns a short confirmation. */
  setTriggers(label: string, changes: P.KeyTrigger[]): Promise<string>;
  setDeadbands(label: string, changes: { index: number; top: number; bottom: number }[]): Promise<string>;
  setKeymap(label: string, layer: P.Layer, changes: { index: number; action: P.RawAction }[]): Promise<string>;
  setSocd(label: string, entries: P.SocdEntry[], on: boolean): Promise<string>;
  /** Replaces the advanced-key table and updates the keymap bindings that point at it. */
  setAdvanced(label: string, entries: P.AdvancedEntry[], bindings: { layer: P.Layer; index: number; action: P.RawAction }[]): Promise<string>;
  setLighting(label: string, config: P.LightConfig): Promise<string>;
  setPollRate(hz: number): Promise<string>;
  setProfile(index: number): Promise<string>;
  setDeviceSettings(label: string, s: P.DeviceSettings): Promise<string>;
  /** Reads everything again. */
  refresh(): Promise<X68View>;
  /** Read-only: saves everything read, the raw replies and the device's HID collections. Returns the file path. */
  exportDiagnostics(): Promise<string>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Link: one request at a time on FF1B:0091, replies matched like illumipc's scheduler
// ---------------------------------------------------------------------------------------------

interface HidSummary {
  key: string;
  vendorId: number;
  productId: number;
  productName: string;
  collections: { usagePage: number; usage: number }[];
}

interface InputPayload {
  key: string;
  reportId: number;
  usagePage?: number;
  usage?: number;
  data: number[];
}

interface Waiting {
  rule: P.ReplyRule;
  pages: Uint8Array[];
  resolve: (pages: Uint8Array[]) => void;
  idle: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => String(e).replace(/^Error: /, "");

/** The first keyboard on one of the ids illumipc's configurator drives (src/lib/illumipc/ids.ts) that has its configurator collection. */
async function findX68(): Promise<HidSummary | null> {
  const list = await invoke<HidSummary[]>("hid_list");
  return (
    list.find(
      (d) => isIllumipcId(d.vendorId, d.productId) && d.collections.some((c) => c.usagePage === ILLUMIPC_COLLECTION.usagePage && c.usage === ILLUMIPC_COLLECTION.usage),
    ) ?? null
  );
}

class Link {
  key: string;
  id = "";
  private waiting: Waiting | null = null;
  private ack: { match: (r: Uint8Array) => boolean; resolve: () => void } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: string[] = [];
  /** Last lines, kept for the diagnostics export. */
  readonly tail: string[] = [];
  /** Every reply by request name, for the backup and diagnostics. */
  readonly raw = new Map<string, string[]>();
  onUnsolicited: ((r: Uint8Array) => void) | null = null;

  constructor(key: string) {
    this.key = key;
  }

  deliver(p: InputPayload) {
    if (p.key !== this.key || p.reportId !== P.X68.reportId) return;
    if (p.usagePage !== undefined && (p.usagePage !== P.X68.usagePage || p.usage !== P.X68.usage)) return;
    const r = Uint8Array.from(p.data);
    if (this.ack?.match(r)) {
      this.ack.resolve();
      return;
    }
    const w = this.waiting;
    if (w && w.rule.match(r)) {
      w.pages.push(r);
      window.clearTimeout(w.idle);
      if (!w.rule.last || w.rule.last(r)) {
        w.resolve(w.pages);
        return;
      }
      w.idle = window.setTimeout(() => w.resolve(w.pages), TIMING.idleMs);
      return;
    }
    this.onUnsolicited?.(r);
  }

  private async send(frame: Uint8Array) {
    P.assertSendable(frame);
    await invoke("hid_send_report_to", { key: this.key, usagePage: P.X68.usagePage, usage: P.X68.usage, reportId: P.X68.reportId, data: Array.from(frame) });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Sends a read and returns its reply pages. Retries like illumipc (2 retries). */
  read(name: string, frame: Uint8Array, opts: { timeoutMs?: number; retries?: number } = {}): Promise<Uint8Array[]> {
    const rule = P.replyRule(frame);
    if (!rule) throw new Error(`No reply rule for ${P.hex(frame)}`);
    const multi = !!rule.last;
    const timeoutMs = opts.timeoutMs ?? (multi ? TIMING.pagesMs : TIMING.replyMs);
    const retries = opts.retries ?? TIMING.retries;
    return this.serial(async () => {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const t0 = performance.now();
        let timer = 0;
        try {
          const pages = await new Promise<Uint8Array[]>((resolve, reject) => {
            this.waiting = { rule, pages: [], resolve, idle: 0 };
            timer = window.setTimeout(() => {
              const w = this.waiting;
              if (w && w.pages.length) resolve(w.pages);
              else reject(new Error(`No answer from the X68 HE to ${P.hex(frame)}.`));
            }, timeoutMs);
            this.send(frame).catch(reject);
          });
          const ms = Math.round(performance.now() - t0);
          const lines = pages.map((p) => P.hex(p));
          this.raw.set(name, lines);
          this.note(`read  ${P.hex(frame)}  <-  ${lines.length > 1 ? `${lines.length} pages: ` : ""}${lines.join(" | ")}  ${ms} ms  [${name}]`);
          return pages;
        } catch (e) {
          lastErr = e;
          this.note(`read  ${P.hex(frame)}  FAILED (try ${attempt + 1})  ${errText(e)}  [${name}]`);
          if (/Blocked/.test(errText(e))) break;
        } finally {
          window.clearTimeout(timer);
          if (this.waiting) window.clearTimeout(this.waiting.idle);
          this.waiting = null;
        }
        await sleep(60);
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    });
  }

  /** Sends a write. Waits briefly for an acknowledgement where illumipc does (keymap, SOCD, dead zones). */
  write(name: string, frame: Uint8Array): Promise<{ acked: boolean | null }> {
    return this.serial(async () => {
      const check = P.assertSendable(frame);
      const ackRule = P.writeAck(frame);
      const t0 = performance.now();
      let acked: boolean | null = null;
      try {
        if (ackRule) {
          const got = new Promise<boolean>((resolve) => {
            this.ack = { match: ackRule, resolve: () => resolve(true) };
            window.setTimeout(() => resolve(false), TIMING.ackMs);
          });
          await this.send(frame);
          acked = await got;
        } else {
          await this.send(frame);
          await sleep(TIMING.writeGapMs);
        }
        this.note(`write ${P.hex(frame)}  ${acked === null ? "sent" : acked ? "acked" : "no ack"}  ${Math.round(performance.now() - t0)} ms  [${check.name}: ${name}]`);
        return { acked };
      } catch (e) {
        this.note(`write ${P.hex(frame)}  FAILED  ${errText(e)}  [${name}]`);
        throw e;
      } finally {
        this.ack = null;
      }
    });
  }

  note(line: string) {
    const l = `${new Date().toISOString()}  ${line}`;
    this.pending.push(l);
    this.tail.push(l);
    if (this.tail.length > 600) this.tail.splice(0, this.tail.length - 600);
  }

  /** Appends to the HID log once the keyboard's id is known. */
  flushLog() {
    if (!this.id || !this.pending.length) return;
    const lines = this.pending.splice(0);
    invoke("keyboard_log", { serial: this.id, lines }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading everything
// ---------------------------------------------------------------------------------------------

const idFrom = (serial: string, product: string) => {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");
  const base = clean(serial).slice(0, 14) || clean(product).slice(-14) || "unknown";
  return `x68he-${base}`;
};

async function readAll(link: Link, usbName: string, usbId: string, progress: (s: string) => void): Promise<X68State> {
  const problems: string[] = [];
  const one = async (name: string, f: Uint8Array) => (await link.read(name, f))[0];
  const attempt = async <T>(section: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (e) {
      problems.push(`${section}: ${errText(e)}`);
      return null;
    }
  };

  progress("Reading keyboard info");
  const status = await attempt("status", async () => P.decodeStatus(await one("status", P.encodeStatus())));
  const product = await attempt("product", async () => P.decodeProduct(await link.read("product", P.encodeProduct())));
  const serial = (await attempt("serial", async () => P.decodeSerial(await one("serial", P.encodeSerial())))) ?? "";
  const id = idFrom(serial, product?.product ?? "");
  link.id = id;
  link.flushLog();

  const chosen = product ? layoutForProduct(product.product) : null;
  if (product && !chosen) problems.push(`layout: SYNQ has no layout for product code ${product.product}`);
  const who = identityFor(product?.product ?? "", usbName);
  const layout = chosen?.layout ?? X68_LAYOUTS.ansi;

  // Onboard profiles: illumipc sends the query and waits for an unsolicited-style answer.
  const profile = await link
    .read("profile", P.encodeProfileQuery(), { timeoutMs: TIMING.profileQueryMs, retries: 0 })
    .then((pages) => P.decodeProfileIndex(pages[0]).index)
    .catch(() => null);

  progress("Reading trigger settings");
  const trigger = await attempt("trigger config", async () => P.decodeTriggerConfig(await one("trigger config", P.encodeTriggerConfigRead()), !!status?.flags.highPrecision));
  const keys: Record<number, P.KeyTrigger> = {};
  if (trigger) {
    const list = layout.keys.filter((k) => !k.locked);
    let failed = 0;
    for (let n = 0; n < list.length; n++) {
      if (n % 8 === 0) progress(`Reading keys ${n + 1}/${list.length}`);
      const k = list[n];
      try {
        keys[k.index] = P.decodeKeyTrigger(await one(`key ${k.index}`, P.encodeKeyTriggerRead(k.index)), k.index);
      } catch {
        failed++;
        if (n < 3 && failed >= 3) break; // illumipc: three silent keys in a row means no per-key reads
      }
    }
    if (failed) problems.push(`key triggers: ${failed} of ${list.length} keys didn't answer`);
  }
  const deadband =
    status?.flags.deadBand === false
      ? null
      : await attempt("dead zones", async () => {
          const r = P.decodeDeadbandPages(await link.read("dead zones", P.encodeDeadbandRead()));
          if (r.seen < P.SLOTS) throw new Error(`only ${r.seen} of ${P.SLOTS} keys came back`);
          return Array.from(r.table);
        });
  const pollHz = await attempt("poll rate", async () => P.decodePollRate(await one("poll rate", P.encodePollRateRead())).hz);

  progress("Reading lighting");
  const light = await attempt("lighting", async () => ({
    modes: P.decodeLightModes(await one("light modes", P.encodeLightModes())),
    config: P.decodeLight(await one("lighting", P.encodeLightRead())),
  }));
  const fnEditable = (await attempt("fn editable", async () => P.decodeFnEditable(await one("fn editable", P.encodeFnEditable())))) ?? [];

  progress("Reading key assignments");
  const layer = async (l: P.Layer) => {
    const r = P.decodeKeymapPages(await link.read(`keymap ${l}`, P.encodeKeymapRead(l)));
    if (r.seen < P.SLOTS) throw new Error(`only ${r.seen} of ${P.SLOTS} slots came back`);
    return Array.from(r.table);
  };
  const keymapDefault = await attempt("keymap default", () => layer("default"));
  const keymapFn = await attempt("keymap fn", () => layer("fn"));

  progress("Reading advanced keys and SOCD");
  const advanced = await attempt("advanced keys", async () => {
    const r = P.decodeAdvancedPages(await link.read("advanced keys", P.encodeAdvancedRead()));
    if (r.seen < P.ADVANCED_SLOTS) throw new Error(`only ${r.seen} of ${P.ADVANCED_SLOTS} slots came back`);
    return r.entries;
  });
  const socd = await attempt("socd", async () => ({
    entries: P.decodeSocdPages(await link.read("socd", P.encodeSocdListRead())),
    on: P.decodeSocdPower(await one("socd switch", P.encodeSocdPowerRead())).on,
  }));
  const switches = status?.flags.moreSwitch
    ? await attempt("switches", async () => ({
        list: P.decodeSwitchList(await one("switch list", P.encodeSwitchListRead())),
        perKey: P.decodeKeySwitchPages(await link.read("key switches", P.encodeKeySwitchRead())),
      }))
    : null;

  progress("Reading macros");
  const macros: MacroSummary[] = [];
  for (let slot = 0; slot < P.MACRO_SLOTS; slot++) {
    try {
      const h = P.decodeMacroHeader(await link.read(`macro ${slot}`, P.encodeMacroRead(slot), { retries: 0, timeoutMs: 1200 }));
      if (h) macros.push({ slot, ...h });
    } catch {
      if (slot === 0) {
        problems.push("macros: the keyboard didn't answer the macro read");
        break;
      }
    }
  }
  link.flushLog();

  return {
    readAt: new Date().toISOString(),
    info: {
      name: who.name,
      brand: who.brand,
      model: who.model,
      x68: who.x68,
      usbId,
      usbName,
      product: product?.product ?? "",
      productText: product?.text ?? "",
      firmware: product?.firmware ?? "",
      serial,
      id,
    },
    status,
    layout,
    layoutKnown: !!chosen?.known,
    trigger,
    keys,
    deadband,
    pollHz,
    profile,
    light,
    keymap: keymapDefault && keymapFn ? { default: keymapDefault, fn: keymapFn } : null,
    fnEditable,
    advanced,
    socd,
    switches,
    macros,
    problems,
  };
}

/** Why writes must stay off for this read, if they must. */
function readOnlyReason(s: X68State): string | null {
  if (!s.info.product) return "The keyboard didn't report its product code, so SYNQ can't tell which layout it has.";
  if (!layoutForProduct(s.info.product)) return `This keyboard reports product ${s.info.product}, which SYNQ has no layout for. SYNQ only reads it.`;
  if (!s.trigger) return "The trigger settings couldn't be read.";
  if (!s.keymap) return "The key assignments couldn't be read in full.";
  const missing = s.layout.keys.filter((k) => !k.locked && !s.keys[k.index]).length;
  if (missing) return `${missing} keys didn't report their trigger settings.`;
  return null;
}

function readWritesFlag(): boolean {
  try {
    return localStorage.getItem(WRITES_KEY) === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------------------------

export async function connectX68(onProgress?: (s: string) => void): Promise<X68Session | null> {
  if (!liveHardware) return previewSession();
  const found = await findX68();
  if (!found) return null;

  const link = new Link(found.key);
  let closed = false;
  const unlistenInput: UnlistenFn = await listen<InputPayload>("hid-input", (e) => link.deliver(e.payload));
  let unlistenLost: UnlistenFn | null = null;

  const open = async (key: string) => {
    await invoke("hid_close", { key }).catch(() => undefined);
    await invoke("hid_open", { key });
    link.key = key;
  };

  try {
    await open(found.key);
    link.note(`open ${found.key} "${found.productName}" collections ${found.collections.map((c) => `${c.usagePage.toString(16)}:${c.usage.toString(16)}`).join(", ")}`);
    let state = await readAll(link, found.productName, idKey(found.vendorId, found.productId), (s) => onProgress?.(s));
    let busy: string | null = null;
    let linkState: X68View["link"] = "ok";
    let writesEnabled = readWritesFlag();
    let backup: string | null = null;
    const listeners = new Set<(v: X68View) => void>();

    const view = (): X68View => {
      const reason = readOnlyReason(state);
      return {
        state,
        link: linkState,
        busy,
        writable: !reason,
        readOnlyReason: reason,
        writesEnabled,
        backup,
        logFile: `${LOG_DIR}\\${state.info.id}-hid-log.txt`,
      };
    };
    let remembered: X68State | null = null;
    const emit = () => {
      session.view = view();
      for (const l of [...listeners]) l(session.view);
      // What the Games page builds profiles from (src/lib/profiles): what was just read, kept.
      if (!busy && state !== remembered && state.trigger && !readOnlyReason(state)) {
        remembered = state;
        const t = state.trigger;
        rememberX68(link.key, state.info.name, {
          trigger: { unitMm: t.unitMm, minUnits: t.minUnits, maxUnits: t.maxUnits, minMm: t.minMm, maxMm: t.maxMm, rtMinMm: t.rtMinMm, rtMaxMm: t.rtMaxMm },
          keys: Object.values(state.keys),
        }, [parseInt(state.info.usbId.slice(0, 4), 16), parseInt(state.info.usbId.slice(5), 16)]);
      }
    };

    // The keyboard switching profiles by itself (Fn shortcut) announces it: read everything again.
    link.onUnsolicited = (r) => {
      if (r[0] === P.CMD.trigger && r[5] === P.TRIG.profileQuery && r[7] !== 1 && !busy) {
        link.note(`profile changed on the keyboard -> ${r[6]}`);
        session.refresh().catch(() => undefined);
      }
    };

    let reopening: Promise<void> | null = null;
    const reopen = (timeoutMs = TIMING.reconnectMs) => {
      reopening ??= (async () => {
        linkState = "reconnecting";
        emit();
        const until = Date.now() + timeoutMs;
        try {
          while (!closed) {
            const d = await findX68().catch(() => null);
            if (d) {
              try {
                await open(d.key);
                await link.read("status", P.encodeStatus());
                linkState = "ok";
                emit();
                return;
              } catch {
                /* still starting up */
              }
            }
            if (Date.now() > until) throw new Error("The keyboard didn't come back. Check the cable, then press Reconnect.");
            await sleep(TIMING.reconnectStepMs);
          }
          throw new Error("Closed.");
        } catch (e) {
          if (!closed) {
            linkState = "lost";
            emit();
          }
          throw e;
        } finally {
          reopening = null;
        }
      })();
      return reopening;
    };
    unlistenLost = await listen<{ key: string }>("hid-lost", (e) => {
      if (!closed && e.payload.key === link.key && !busy?.startsWith("Polling")) reopen().catch(() => undefined);
    });

    const backupJson = (kind: string) =>
      JSON.stringify({ kind, savedAt: new Date().toISOString(), app: "SYNQ", device: { vid: state.info.usbId.slice(0, 4), pid: state.info.usbId.slice(5), usbName: state.info.usbName }, state, raw: Object.fromEntries(link.raw) }, null, 1);

    const ensureBackup = async () => {
      if (backup) return;
      const id = state.info.id;
      const original = await invoke<string | null>("keyboard_state_load", { serial: `${id}-original` }).catch(() => null);
      if (!original) await invoke("keyboard_state_save", { serial: `${id}-original`, json: backupJson("x68he-original") });
      const name = `${id}-backup-${Math.floor(Date.now() / 1000)}`;
      await invoke("keyboard_state_save", { serial: name, json: backupJson("x68he-backup") });
      backup = `${LOG_DIR}\\${name}.json`;
      link.note(`backup saved ${backup}`);
    };

    let chain: Promise<unknown> = Promise.resolve();
    /** Runs one write operation: checks, backup, the write, read-back. One at a time. */
    const mutate = (label: string, run: () => Promise<string>): Promise<string> => {
      const next = chain.then(async () => {
        if (reopening) await reopening;
        const reason = readOnlyReason(state);
        if (reason) throw new Error(`Changes are off: ${reason}`);
        if (!writesEnabled) throw new Error("Changes are switched off. Turn on \"Allow changes\" first.");
        if (linkState !== "ok") throw new Error("The keyboard isn't connected right now.");
        busy = label;
        emit();
        try {
          await ensureBackup();
          link.note(`--- ${label}`);
          return await run();
        } finally {
          busy = null;
          link.flushLog();
          emit();
        }
      });
      chain = next.catch(() => undefined);
      return next;
    };

    const waitStoring = async () => {
      const until = Date.now() + TIMING.storingMs;
      while (Date.now() < until) {
        const r = await link.read("storing?", P.encodeStatus(), { retries: 0 }).catch(() => null);
        if (!r || !P.isStoring(r[0])) return;
        await sleep(60);
      }
    };

    const readLayer = async (l: P.Layer) => {
      const r = P.decodeKeymapPages(await link.read(`keymap ${l}`, P.encodeKeymapRead(l)));
      if (r.seen < P.SLOTS) throw new Error(`Read-back of the ${l} layer was incomplete.`);
      return Array.from(r.table);
    };

    const writeLayer = async (l: P.Layer, table: number[]) => {
      for (const f of P.encodeKeymapWrite(l, Uint8Array.from(table))) await link.write(`keymap ${l}`, f);
      await waitStoring();
      const back = await readLayer(l);
      const diff = back.findIndex((v, i) => v !== table[i]);
      state = { ...state, keymap: { ...state.keymap!, [l]: back } };
      if (diff >= 0) throw new Error(`The keyboard kept a different value for key slot ${Math.floor(diff / 4)} on the ${l} layer.`);
    };

    const session: X68Session = {
      view: view(),
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      setWritesEnabled(on) {
        writesEnabled = on;
        try {
          localStorage.setItem(WRITES_KEY, on ? "1" : "0");
        } catch {
          /* preference only */
        }
        link.note(`changes ${on ? "allowed" : "switched off"} by the user`);
        link.flushLog();
        emit();
      },

      setTriggers: (label, changes) =>
        mutate(label, async () => {
          const t = state.trigger!;
          for (const c of changes) {
            if (c.travel < t.minUnits || c.travel > t.maxUnits) throw new Error(`Actuation must be between ${t.minMm} and ${t.maxMm} mm.`);
            if (c.mode !== P.TRIGGER_MODE.normal && (c.press < 1 || c.release < 1 || c.press * t.unitMm > t.rtMaxMm + 1e-9 || c.release * t.unitMm > t.rtMaxMm + 1e-9))
              throw new Error(`Rapid-trigger sensitivity must be between ${t.rtMinMm} and ${t.rtMaxMm} mm.`);
          }
          for (const f of P.encodeTriggerWrites(changes)) await link.write("triggers", f);
          const keys = { ...state.keys };
          const wrong: number[] = [];
          for (const c of changes) {
            const back = P.decodeKeyTrigger((await link.read(`key ${c.index}`, P.encodeKeyTriggerRead(c.index)))[0], c.index);
            keys[c.index] = back;
            const same = back.mode === c.mode && back.travel === c.travel && (c.mode === P.TRIGGER_MODE.normal || (back.press === c.press && back.release === c.release));
            if (!same) wrong.push(c.index);
          }
          state = { ...state, keys };
          if (wrong.length) throw new Error(`${wrong.length} of ${changes.length} keys read back different values.`);
          return `Confirmed on ${changes.length} ${changes.length === 1 ? "key" : "keys"}`;
        }),

      setDeadbands: (label, changes) =>
        mutate(label, async () => {
          if (!state.deadband) throw new Error("This keyboard has no dead-zone settings.");
          const maxUnits = Math.ceil(1 / state.trigger!.unitMm);
          const table = [...state.deadband];
          for (const c of changes) {
            if (c.top < 0 || c.bottom < 0 || c.top > maxUnits || c.bottom > maxUnits) throw new Error("Dead zones go from 0 to 1 mm.");
            table[c.index * 2] = c.top;
            table[c.index * 2 + 1] = c.bottom;
          }
          for (const f of P.encodeDeadbandWrite(Uint8Array.from(table))) await link.write("dead zones", f);
          const r = P.decodeDeadbandPages(await link.read("dead zones", P.encodeDeadbandRead()));
          const back = Array.from(r.table);
          state = { ...state, deadband: back };
          if (back.some((v, i) => v !== table[i])) throw new Error("The keyboard read back different dead zones.");
          return "Dead zones confirmed";
        }),

      setKeymap: (label, layer, changes) =>
        mutate(label, async () => {
          let table: Uint8Array = Uint8Array.from(state.keymap![layer]);
          for (const c of changes) {
            const key = state.layout.keys.find((k) => k.index === c.index);
            if (!key || key.locked) throw new Error("That key can't be changed.");
            if (layer === "fn" && state.fnEditable.length && !state.fnEditable.includes(c.index)) throw new Error("The keyboard doesn't allow changing that key on the Fn layer.");
            table = P.withAction(table, c.index, c.action);
          }
          await writeLayer(layer, Array.from(table));
          return "Key assignment confirmed";
        }),

      setSocd: (label, entries, on) =>
        mutate(label, async () => {
          const nonUs = !state.layout.usType;
          const packed = entries.map((e, i) => ({ ...e, index: i }));
          for (const f of P.encodeSocdWrite(packed, nonUs)) await link.write("socd", f);
          if (!state.socd || state.socd.on !== on) await link.write("socd switch", P.encodeSocdPowerWrite(on));
          const back = {
            entries: P.decodeSocdPages(await link.read("socd", P.encodeSocdListRead())),
            on: P.decodeSocdPower((await link.read("socd switch", P.encodeSocdPowerRead()))[0]).on,
          };
          state = { ...state, socd: back };
          const expect = packed.map((e) => `${e.index}:${e.mode}:${e.key1}:${nonUs && e.key2 === 0x31 ? 0x32 : e.key2}`).join();
          const got = back.entries.map((e) => `${e.index}:${e.mode}:${e.key1}:${e.key2}`).join();
          if (expect !== got || back.on !== on) throw new Error("The keyboard read back different SOCD settings.");
          return "SOCD confirmed";
        }),

      setAdvanced: (label, entries, bindings) =>
        mutate(label, async () => {
          for (const f of P.encodeAdvancedTable(entries)) await link.write("advanced keys", f);
          await sleep(10);
          const r = P.decodeAdvancedPages(await link.read("advanced keys", P.encodeAdvancedRead()));
          state = { ...state, advanced: r.entries };
          const norm = (list: P.AdvancedEntry[]) => list.map((e) => P.hex(P.encodeAdvancedWrite(e.slot, e))).join("|");
          if (norm(r.entries) !== norm([...entries].sort((a, b) => a.slot - b.slot))) throw new Error("The keyboard read back different advanced keys.");
          for (const l of ["default", "fn"] as const) {
            const mine = bindings.filter((b) => b.layer === l);
            if (!mine.length) continue;
            let table: Uint8Array = Uint8Array.from(state.keymap![l]);
            for (const b of mine) table = P.withAction(table, b.index, b.action);
            await writeLayer(l, Array.from(table));
          }
          return "Advanced keys confirmed";
        }),

      setLighting: (label, config) =>
        mutate(label, async () => {
          const m = state.light?.modes;
          if (m && (config.brightness > m.maxBrightness || config.speed > m.maxSpeed)) throw new Error("Brightness or speed out of range.");
          await link.write("lighting", P.encodeLightWrite(config));
          const back = P.decodeLight((await link.read("lighting", P.encodeLightRead()))[0]);
          state = { ...state, light: state.light ? { ...state.light, config: back } : null };
          const keys: (keyof P.LightConfig)[] = ["mode", "brightness", "speed", "direction", "fullColor", "power"];
          const colorSame = back.color.r === config.color.r && back.color.g === config.color.g && back.color.b === config.color.b;
          if (keys.some((k) => back[k] !== config[k]) || !colorSame) throw new Error("The keyboard read back different lighting settings.");
          return "Lighting confirmed";
        }),

      setPollRate: (hz) =>
        mutate(`Polling rate ${hz} Hz`, async () => {
          busy = "Polling rate: waiting for the keyboard to restart";
          emit();
          await link.write("poll rate", P.encodePollRateWrite(hz)).catch(() => undefined);
          await sleep(TIMING.pollSettleMs);
          const alive = await link
            .read("status", P.encodeStatus(), { retries: 0 })
            .then(() => true)
            .catch(() => false);
          if (!alive) await reopen();
          const back = P.decodePollRate((await link.read("poll rate", P.encodePollRateRead()))[0]).hz;
          state = { ...state, pollHz: back };
          if (back !== hz) throw new Error(`The keyboard reports ${back ?? "an unknown rate"} after the change.`);
          return `Polling rate confirmed at ${hz} Hz`;
        }),

      setProfile: (index) =>
        mutate(`Profile ${index === 0 ? "Default" : index}`, async () => {
          if (state.profile === null) throw new Error("This keyboard doesn't keep profiles on board.");
          await link.write("profile", P.encodeProfileSet(index));
          const until = Date.now() + 1500;
          let now: number | null = null;
          while (Date.now() < until) {
            now = await link
              .read("profile", P.encodeProfileQuery(), { timeoutMs: 300, retries: 0 })
              .then((p) => P.decodeProfileIndex(p[0]).index)
              .catch(() => null);
            if (now === index) break;
            await sleep(100);
          }
          if (now !== index) throw new Error("The keyboard didn't switch profiles.");
          busy = "Reading the new profile";
          emit();
          state = await readAll(link, state.info.usbName, state.info.usbId, (s) => {
            busy = s;
            emit();
          });
          return `Now on ${index === 0 ? "the Default profile" : `Profile ${index}`}`;
        }),

      setDeviceSettings: (label, s) =>
        mutate(label, async () => {
          await link.write("device settings", P.encodeDeviceSettings(s));
          const st = P.decodeStatus((await link.read("status", P.encodeStatus()))[0]);
          state = { ...state, status: st };
          const w = st.winLock;
          if (w.lockWin !== s.lockWin || w.lockShiftTab !== s.lockShiftTab || w.lockAltF4 !== s.lockAltF4 || w.lockAltTab !== s.lockAltTab) throw new Error("The keyboard read back different lock settings.");
          return "Confirmed";
        }),

      async refresh() {
        if (reopening) await reopening.catch(() => undefined);
        const next = chain.then(async () => {
          busy = "Reading";
          emit();
          try {
            state = await readAll(link, state.info.usbName, state.info.usbId, (s) => {
              busy = s;
              emit();
            });
          } finally {
            busy = null;
            emit();
          }
          return session.view;
        });
        chain = next.catch(() => undefined);
        return next;
      },

      async exportDiagnostics() {
        const devices = await invoke<unknown[]>("devices_list").catch((e) => [`devices_list failed: ${errText(e)}`]);
        const hid = await invoke<unknown[]>("hid_list").catch((e) => [`hid_list failed: ${errText(e)}`]);
        const name = `${state.info.id}-diag-${Math.floor(Date.now() / 1000)}`;
        const json = JSON.stringify(
          {
            kind: "x68he-diagnostics",
            savedAt: new Date().toISOString(),
            app: "SYNQ",
            note: "Read-only export: nothing was written to the keyboard to make this file.",
            usb: { vid: state.info.usbId.slice(0, 4), pid: state.info.usbId.slice(5), key: link.key, productName: state.info.usbName },
            collections: { allDetected: devices, openedByOnBoard: hid },
            view: { writable: view().writable, readOnlyReason: view().readOnlyReason, writesEnabled, backup },
            state,
            raw: Object.fromEntries(link.raw),
            log: link.tail,
          },
          null,
          1,
        );
        await invoke("keyboard_state_save", { serial: name, json });
        link.note(`diagnostics saved ${name}.json`);
        link.flushLog();
        return `${LOG_DIR}\\${name}.json`;
      },

      async close() {
        closed = true;
        unlistenInput();
        unlistenLost?.();
        link.flushLog();
        await invoke("hid_close", { key: link.key }).catch(() => undefined);
      },
    };
    return session;
  } catch (e) {
    unlistenInput();
    unlistenLost?.();
    link.flushLog();
    await invoke("hid_close", { key: link.key }).catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Browser preview: a sample X68 HE (ISO UK), nothing touches hardware
// ---------------------------------------------------------------------------------------------

function sampleState(): X68State {
  const layout = X68_LAYOUTS["iso-uk"];
  const keys: Record<number, P.KeyTrigger> = {};
  for (const k of layout.keys) if (!k.locked) keys[k.index] = { index: k.index, mode: 0, travel: 120, press: 50, release: 50 };
  for (const i of [45, 46, 47, 68, 69, 70]) keys[i] = { index: i, mode: P.TRIGGER_MODE.rapid, travel: 60, press: 15, release: 15 };
  keys[88] = { index: 88, mode: 0, travel: 200, press: 50, release: 50 };
  const table = (l: P.Layer) => {
    const t = new Uint8Array(P.KEYMAP_BYTES);
    for (const k of layout.keys) t.set(l === "default" ? k.factory : [0, 0, 0, 0], k.index * 4);
    if (l === "fn") {
      for (let n = 0; n < 10; n++) t.set([0, 0x3a + n, 0, 0], (23 + n) * 4);
      t.set([P.ACTION.media, 0x12, 0, 0], 33 * 4);
      t.set([P.ACTION.lightBrightness, 0, 0, 0], 103 * 4);
      t.set([P.ACTION.lightBrightness, 1, 0, 0], 125 * 4);
    } else t.set([P.ACTION.combo, 0xe0, 0x06, 0], 38 * 4);
    return Array.from(t);
  };
  return {
    readAt: new Date().toISOString(),
    info: { name: X68_NAME, brand: "MAGIC-REFINER", model: "X68 HE", x68: true, usbId: "2e3c:c365", usbName: "X68HE", product: "AK1680UKX68ZAXHEARGB", productText: "0,0,0,0,AK1680UKX68ZAXHEARGB,V1_0_3", firmware: "1.0.3", serial: "PREVIEW", id: "x68he-PREVIEW" },
    status: P.decodeStatus(Uint8Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0x18, 0x19, 1, 0, 0, 0])),
    layout,
    layoutKnown: true,
    trigger: P.decodeTriggerConfig(Uint8Array.from([0x21, 0, 0, 0, 24, 4, 0x90, 10, 10, 1, 10]), true),
    keys,
    deadband: Array.from({ length: P.DEADBAND_BYTES }, () => 0),
    pollHz: 8000,
    profile: null,
    light: {
      modes: { modes: [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16], maxBrightness: 4, maxSpeed: 4 },
      config: { mode: 2, brightness: 3, speed: 2, color: { r: 139, g: 92, b: 246 }, background: { r: 0, g: 0, b: 0 }, direction: 1, fullColor: 1, power: 0, timer: 0 },
    },
    keymap: { default: table("default"), fn: table("fn") },
    fnEditable: layout.keys.filter((k) => !k.locked).map((k) => k.index),
    advanced: [
      { slot: 0, type: "MT", actions: [[0, 0x29, 0, 0], [0, 0xe0, 0, 0]], duration: 15 },
      { slot: 1, type: "DKS", actions: [[0, 0x2c, 0, 0], [0, 0x06, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], travelPoints: [15, 36, 36, 15], steps: [1, 0, 0, 0, 0, 2, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0] },
    ],
    socd: { on: true, entries: [{ index: 0, state: 1, mode: 0, key1: 0x04, key2: 0x07 }] },
    switches: null,
    macros: [],
    problems: [],
  };
}

function previewSession(): X68Session {
  let state = sampleState();
  // Caps Lock is the sample tap/hold key (slot 0), Space the sample DKS (slot 1).
  state.keymap!.default = Array.from(P.withAction(Uint8Array.from(state.keymap!.default), 66, [P.ACTION.advanced, 0, 0, 0]));
  state.keymap!.default = Array.from(P.withAction(Uint8Array.from(state.keymap!.default), 116, [P.ACTION.advanced, 1, 1, 0]));
  let busy: string | null = null;
  let writesEnabled = true;
  const listeners = new Set<(v: X68View) => void>();
  const view = (): X68View => ({
    state,
    link: "ok",
    busy,
    writable: true,
    readOnlyReason: null,
    writesEnabled,
    backup: null,
    logFile: `${LOG_DIR}\\x68he-PREVIEW-hid-log.txt`,
  });
  const emit = () => {
    session.view = view();
    for (const l of [...listeners]) l(session.view);
  };
  const fake = async (label: string, apply: () => void): Promise<string> => {
    if (!writesEnabled) throw new Error("Changes are switched off. Turn on \"Allow changes\" first.");
    busy = label;
    emit();
    await sleep(260);
    apply();
    busy = null;
    emit();
    return "Preview: nothing was sent";
  };
  const session: X68Session = {
    view: view(),
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setWritesEnabled(on) {
      writesEnabled = on;
      emit();
    },
    setTriggers: (label, changes) =>
      fake(label, () => {
        const keys = { ...state.keys };
        for (const c of changes) keys[c.index] = { ...c, release: c.mode === P.TRIGGER_MODE.rapid ? c.press : c.release };
        state = { ...state, keys };
      }),
    setDeadbands: (label, changes) =>
      fake(label, () => {
        const t = [...(state.deadband ?? [])];
        for (const c of changes) {
          t[c.index * 2] = c.top;
          t[c.index * 2 + 1] = c.bottom;
        }
        state = { ...state, deadband: t };
      }),
    setKeymap: (label, layer, changes) =>
      fake(label, () => {
        let t: Uint8Array = Uint8Array.from(state.keymap![layer]);
        for (const c of changes) t = P.withAction(t, c.index, c.action);
        state = { ...state, keymap: { ...state.keymap!, [layer]: Array.from(t) } };
      }),
    setSocd: (label, entries, on) => fake(label, () => (state = { ...state, socd: { on, entries: entries.map((e, i) => ({ ...e, index: i, state: 1 })) } })),
    setAdvanced: (label, entries, bindings) =>
      fake(label, () => {
        const km = { ...state.keymap! };
        for (const b of bindings) km[b.layer] = Array.from(P.withAction(Uint8Array.from(km[b.layer]), b.index, b.action));
        state = { ...state, advanced: [...entries].sort((a, b) => a.slot - b.slot), keymap: km };
      }),
    setLighting: (label, config) => fake(label, () => (state = { ...state, light: state.light ? { ...state.light, config } : null })),
    setPollRate: (hz) => fake(`Polling rate ${hz} Hz`, () => (state = { ...state, pollHz: hz })),
    setProfile: (index) => fake(`Profile ${index}`, () => (state = { ...state, profile: index })),
    setDeviceSettings: (label) => fake(label, () => undefined),
    async refresh() {
      return session.view;
    },
    async exportDiagnostics() {
      await sleep(200);
      return `${LOG_DIR}\\x68he-PREVIEW-diag-preview.json (preview: not saved)`;
    },
    async close() {},
  };
  return session;
}
