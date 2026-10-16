// The website's link to SYNQ Helper (src-tauri/helper): the small tray process that comes with the desktop app
// or on its own (one file from the website, which installs itself). With it, the website reaches what a browser
// can't: Razer devices on Windows Chromium 153+, the EQ, the Advanced actions, monitors (DDC/CI), webcams and
// the Wi-Fi lights (a page can't reach the local network). Every report still goes
// through the desktop app's own Rust guards (the helper runs the same hid.rs / brands.rs / advanced.rs); the
// browser's guard (guard.ts) isn't in that path because WebHID isn't either.
//
// - A WebSocket to ws://127.0.0.1:17860/ (this PC only). The helper accepts only this site's origin.
// - Nothing connects by itself the first time: the person presses Get SYNQ Helper (then the page looks for it
//   while it installs) or Connect (Chrome may ask to allow access to devices on the local network, and the
//   helper asks once whether to allow this site). After that the page reconnects on load, with the token the
//   helper gave it, the way OpenMouse's site finds its Bridge.
// - Which transport a page uses is decided once, when it loads (`helperSettled`), so device keys from
//   the helper and from WebHID never mix. Connecting or disconnecting reloads the page.
import { readSetting, writeSetting } from "./settings.ts";
import { emit } from "./tauri-event.ts";

export const HELPER_PORT = 17860;
export const HELPER_URL = `ws://127.0.0.1:${HELPER_PORT}/`;
/** The commands the helper answers (named as the desktop app's). Everything else stays in the browser. */
export const HELPER_COMMANDS: ReadonlySet<string> = new Set([
  "hid_list",
  "hid_open",
  "hid_close",
  "hid_send_report",
  "hid_send_report_to",
  "hid_send_feature_report",
  "hid_receive_feature_report",
  "hid_advanced_grant",
  "hid_advanced_revoke",
  "hid_advanced_status",
  "devices_list",
  "monitor_caps",
  "monitor_read",
  "monitor_write",
  "webcam_controls",
  "webcam_set",
  "net_lights_find",
  "net_light_pair",
  "net_light_forget",
  "net_light_send",
  "net_sync_start",
  "net_sync_stop",
  "net_sync_state",
  "screen_monitors",
  "hue_areas",
  "hue_area_create",
  "hue_area_remove",
  "rgbhub_write",
  "rgbhub_read",
  "rgbhub_close",
  "eq_load",
  "eq_apply",
  "eq_presets",
  "eq_preset_read",
  "eq_engine_status",
  "eq_engine_setup",
  "eq_engine_install",
  "eq_engine_undo",
  "sound_names_load",
]);

const WANT = "helper";
const TOKEN = "helper.token";
/** The person downloaded the helper on this browser: the page looks for it on load, until it has connected once. */
const EXPECT = "helper.expected";
/** How long the page keeps looking for a helper that is being installed, and how often. */
const WAIT_MS = 5 * 60_000;
const RETRY_MS = 3000;
const CONNECT_MS = 1500;
/** The helper may be showing its "allow this site?" question: give the person time to answer. */
const PAIR_MS = 120_000;
const CALL_MS = 30_000;

export type HelperState = "off" | "connecting" | "ready" | "failed";

let state: HelperState = "off";
let lastError = "";
let socket: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
let settled: Promise<void> | null = null;

function set(s: HelperState, error = "") {
  state = s;
  lastError = error;
  for (const l of [...listeners]) l();
}

export const helperState = (): HelperState => state;
export const helperError = (): string => lastError;
export const helperReady = (): boolean => state === "ready";
/** The person connected the helper on this browser before (so the page reconnects on load). */
export const wantsHelper = (): boolean => readSetting(WANT) === "on";
/** The person downloaded the helper here and it hasn't connected yet. */
export const expectingHelper = (): boolean => readSetting(EXPECT) === "on";

/** The person pressed Get SYNQ Helper: from now on the page looks for it (here and on every load) until it connects. */
export function expectHelper(): void {
  writeSetting(EXPECT, "on");
}

/**
 * Looks for a helper that is being installed (the file just downloaded, about to be run): a quiet try every few
 * seconds, for a few minutes. Once one answers it connects (the helper asks once whether to allow this site).
 * True when connected; false when stopped or it never came.
 */
export async function waitForHelper(stop: AbortSignal): Promise<boolean> {
  const until = Date.now() + WAIT_MS;
  while (!stop.aborted && Date.now() < until) {
    try {
      (await open(CONNECT_MS)).close();
      return await connectHelper(true);
    } catch {
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  return false;
}

export function onHelperChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function failAll(why: string) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(why));
  }
  pending.clear();
}

function send<T>(cmd: string, args: unknown, ms: number): Promise<T> {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("SYNQ Helper isn't connected."));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("SYNQ Helper didn't answer."));
    }, ms);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    ws.send(JSON.stringify({ id, cmd, args: args ?? {} }));
  });
}

function onMessage(ev: MessageEvent) {
  let msg: { id?: number; ok?: unknown; err?: string; event?: string; payload?: unknown };
  try {
    msg = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  if (msg.event) {
    emit(msg.event, msg.payload);
    return;
  }
  const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
  if (!p) return;
  pending.delete(msg.id as number);
  clearTimeout(p.timer);
  if (msg.err !== undefined) p.reject(new Error(msg.err));
  else p.resolve(msg.ok ?? null);
}

function open(ms: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(HELPER_URL);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("SYNQ Helper isn't running on this PC."));
    }, ms);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("SYNQ Helper isn't running on this PC, or the browser blocked the connection."));
    };
  });
}

/** Connects and pairs. `interactive`: the person pressed Connect (so the helper may ask them). */
export async function connectHelper(interactive = false): Promise<boolean> {
  if (state === "ready") return true;
  set("connecting");
  try {
    const ws = await open(interactive ? 5000 : CONNECT_MS);
    socket = ws;
    ws.onmessage = onMessage;
    ws.onclose = () => {
      socket = null;
      failAll("SYNQ Helper closed the connection.");
      if (state === "ready") set("failed", "SYNQ Helper stopped. Reload the page after starting it again.");
    };
    const token = readSetting(TOKEN) ?? undefined;
    const r = await send<{ paired: boolean; token?: string }>("hello", { token }, interactive ? PAIR_MS : CALL_MS);
    if (r.token) writeSetting(TOKEN, r.token);
    writeSetting(WANT, "on");
    writeSetting(EXPECT, null);
    set("ready");
    return true;
  } catch (e) {
    socket?.close();
    socket = null;
    set("failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * The page's one decision: on load, reconnect if the person connected the helper before. Resolves when
 * that's done (or at once when they never did). Every caller that picks a transport awaits this.
 */
export function helperSettled(): Promise<void> {
  // Downloaded but not yet connected: the first answer may be the helper asking whether to allow this site, so it
  // gets the time to be answered.
  settled ??= wantsHelper() || expectingHelper() ? connectHelper(!wantsHelper()).then(() => undefined) : Promise.resolve();
  return settled;
}

/** Stops using the helper on this browser (the page reloads onto WebHID). */
export function forgetHelper(): void {
  writeSetting(WANT, null);
  writeSetting(TOKEN, null);
  writeSetting(EXPECT, null);
  socket?.close();
  socket = null;
  set("off");
}

/** One command on the helper. */
export function helperCall<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return send<T>(cmd, args, CALL_MS);
}
