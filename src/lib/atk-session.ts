// ATK mouse session: talks to the X1 V2 Air+ over its 8K receiver (vendor collection FF02:0002 only),
// given an opened HID device and a place to keep backups. Same shape as the Logitech MouseSession where
// it fits: read a view, change one thing, read it back. Every frame passes atk-protocol's checkFrame,
// every write is read back, and the mouse's rows are backed up once per session before the first write.
// No Tauri here (src/lib/atk-mouse.ts adds it), so the tests and the browser preview's simulated mouse
// (src/lib/atk-sim.ts) run exactly this code.
//
// OpenMouse's AtkHidClient isn't used directly: its catalog doesn't list the 8K receiver
// (373b:1278), so it would fall back to the 4-byte DPI rows at 0x000c and put angle snapping at
// 0x00bd, both wrong for this mouse. The model is resolved by CID/MID instead (see atk-protocol).
import { rememberAtk } from "./profiles/state.ts";
import { atkDevicesForCidMid } from "@openmouse/protocol/drivers/atk/device-catalog.generated";
import * as P from "./atk-protocol.ts";
import { NoReply, Wire, hex } from "./atk-wire.ts";
import { AdvancedGate, nativeOf } from "./advanced/core.ts";
import type { AdvancedPanel } from "./advanced/types.ts";
import { atkAdvanced } from "./atk-advanced.ts";

export interface AtkView {
  name: string;
  cidMid: string;
  connection: "Wired" | "Wireless";
  connectionDetail: string;
  batteryPercent: number | null;
  charging: boolean | null;
  firmware: string | null;
  receiverFirmware: string | null;
  sensorLabel: string;
  writable: boolean;
  /** Why writes are off, when they are. */
  readOnlyReason: string | null;
  stages: number[];
  activeStage: number;
  dpi: number;
  dpiRange: { min: number; max: number; step: number; maxStages: number };
  pollingHz: number;
  pollingOptions: number[];
  liftOffMm: number | null;
  angleSnapping: boolean;
  rippleControl: boolean;
  motionSync: boolean;
  debounceMs: number;
  debounceOptions: number[];
  sensorMode: P.SensorMode | null;
  sleepSeconds: number;
}

export interface AtkSession {
  view: AtkView;
  refresh(): Promise<AtkView>;
  /** Writes the steps and makes `activeStage` the one the mouse runs. */
  saveStages(stages: number[], activeStage: number): Promise<AtkView>;
  /** Runs `dpi` now: picks the step that already has it, else gives the active step that value. */
  setActiveDpi(dpi: number): Promise<AtkView>;
  setPolling(hz: number): Promise<AtkView>;
  setLiftOff(mm: number): Promise<AtkView>;
  setAngleSnapping(on: boolean): Promise<AtkView>;
  setRippleControl(on: boolean): Promise<AtkView>;
  setMotionSync(on: boolean): Promise<AtkView>;
  setDebounce(ms: number): Promise<AtkView>;
  setSensorMode(mode: P.SensorMode): Promise<AtkView>;
  /** Pairing, button changes and a factory reset, behind the Advanced card's confirmation. */
  readonly advanced: AdvancedPanel;
  close(): Promise<void>;
}

/** The mouse (not the receiver) stayed silent: asleep, off, or out of range. */
export class MouseAsleep extends Error {
  constructor() {
    super("The mouse is asleep or out of range. Move it to wake it up, then press Reconnect.");
  }
}

const BACKUP_PREFIX = "atk-x1-v2-air";

interface Rows {
  system: number[];
  liftOff: number[];
  stages: number[][];
  function: number[];
  performance: number[];
}

interface Identity {
  cidMid: string;
  model: P.AtkModel;
  link: (typeof P.ATK_LINKS)[number];
  firmware: string | null;
  receiverFirmware: string | null;
}

/** SYNQ's own table first; otherwise a PAW3955 Master model from the ATK catalog, read-only. */
function modelFor(cidMid: string): P.AtkModel {
  const known = P.ATK_MODELS[cidMid];
  if (known) return known;
  const listed = atkDevicesForCidMid(cidMid).filter((d) => d.vendorId === P.ATK_VENDOR_ID);
  const entry = listed.length === 1 ? listed[0] : undefined;
  if (entry?.sensor === "PAW3955Master") {
    return {
      name: entry.model.replace(/^ATK\s+/i, ""),
      sensor: "PAW3955Master",
      sensorLabel: "PAW3955 Master",
      verified: false,
      debounceFromZero: entry.features.noZeroKeyDebounce !== true,
    };
  }
  const what = entry ? `the ${entry.model}` : `this ATK mouse (CID/MID ${cidMid})`;
  throw new Error(`SYNQ doesn't know ${what} yet, so it won't read or change its settings.`);
}

async function identify(wire: Wire, productId: number): Promise<Identity> {
  const link = P.ATK_LINKS[productId];
  if (!link) throw new Error(`Unknown ATK device 0x${productId.toString(16)}.`);
  if (link.wireless) {
    // The receiver answers this itself, so it tells "asleep" apart from "not plugged in".
    const online = await wire.command(P.CMD.getMouseOnline);
    if (online[P.DATA_OFFSET] !== 1) throw new MouseAsleep();
  }
  const id = await wire.command(P.CMD.getCidMid).catch((e) => {
    throw e instanceof NoReply ? new MouseAsleep() : e;
  });
  const cidMid = `${id[P.DATA_OFFSET]},${id[P.DATA_OFFSET + 1]}`;
  const version = await wire.command(P.CMD.getVersion).catch(() => null);
  const dongle = link.wireless ? await wire.command(P.CMD.getDongleVersion).catch(() => null) : null;
  return {
    cidMid,
    model: modelFor(cidMid),
    link,
    firmware: version && version[4] >= 2 ? P.bcdVersion(version[5], version[6]) : null,
    receiverFirmware: dongle && dongle[4] >= 2 ? P.bcdVersion(dongle[5], dongle[6]) : null,
  };
}

async function readRows(wire: Wire): Promise<Rows> {
  const system = await wire.read(P.ADDR.system, P.SYSTEM_LENGTH);
  const { stageCount } = P.decodeSystem(system);
  const stages: number[][] = [];
  for (let i = 0; i < stageCount; i++) stages.push(await wire.read(P.ADDR.paw3955Dpi + i * P.PAW3955_STAGE_LENGTH, P.PAW3955_STAGE_LENGTH));
  return {
    system,
    stages,
    liftOff: await wire.read(P.ADDR.liftOff, 2),
    function: await wire.read(P.ADDR.function, P.FUNCTION_LENGTH),
    performance: await wire.read(P.ADDR.performance, P.PERFORMANCE_LENGTH),
  };
}

function toView(id: Identity, rows: Rows, battery: Uint8Array | null): AtkView {
  const sys = P.decodeSystem(rows.system);
  const fn = P.decodeFunction(rows.function);
  const stages = rows.stages.map((r) => P.unpackPaw3955Stage(r).x);
  const lod = P.unpair(rows.liftOff[0], rows.liftOff[1]);
  const readOnlyReason = !id.link.verified
    ? "SYNQ hasn't been checked with this mouse on a cable yet, so it shows its settings without changing them. Use the 8K receiver to change them."
    : !id.model.verified
      ? "This ATK model isn't confirmed yet, so SYNQ shows its settings without changing them."
      : null;
  const pollingOptions = [...id.link.rates];
  return {
    name: id.model.name,
    cidMid: id.cidMid,
    connection: id.link.wireless ? "Wireless" : "Wired",
    connectionDetail: id.link.detail,
    batteryPercent: battery && battery[4] >= 1 ? Math.min(battery[P.DATA_OFFSET], 100) : null,
    charging: battery && battery[4] >= 2 ? battery[P.DATA_OFFSET + 1] !== 0 : null,
    firmware: id.firmware,
    receiverFirmware: id.receiverFirmware,
    sensorLabel: id.model.sensorLabel,
    writable: readOnlyReason === null,
    readOnlyReason,
    stages,
    activeStage: sys.activeStage,
    dpi: stages[sys.activeStage] ?? stages[0] ?? 0,
    dpiRange: { ...P.PAW3955_DPI, maxStages: P.PAW3955_MAX_STAGES },
    pollingHz: sys.pollingHz,
    pollingOptions: pollingOptions.includes(sys.pollingHz) ? pollingOptions : [...pollingOptions, sys.pollingHz].sort((a, b) => a - b),
    liftOffMm: lod === null ? null : P.liftOffMm(lod),
    angleSnapping: fn.angleSnapping,
    rippleControl: fn.rippleControl,
    motionSync: fn.motionSync,
    debounceMs: fn.debounceMs,
    debounceOptions: P.DEBOUNCE_MS.filter((ms) => ms > 0 || id.model.debounceFromZero),
    sensorMode: P.decodeSensorMode(rows.performance),
    sleepSeconds: fn.sleepSeconds,
  };
}

export type Save = (prefix: string, json: string) => Promise<string>;

/** Everything SYNQ can change, plus the rest of the stage table and identity, as read right now. */
async function backup(wire: Wire, id: Identity, save: Save) {
  const allStages: string[] = [];
  for (let i = 0; i < P.PAW3955_MAX_STAGES; i++) allStages.push(hex(await wire.read(P.ADDR.paw3955Dpi + i * P.PAW3955_STAGE_LENGTH, P.PAW3955_STAGE_LENGTH)));
  const json = JSON.stringify(
    {
      savedAt: new Date().toISOString(),
      device: `ATK ${id.model.name} via ${id.link.detail}`,
      cidMid: id.cidMid,
      firmware: id.firmware,
      receiverFirmware: id.receiverFirmware,
      rows: {
        system: hex(await wire.read(P.ADDR.system, P.SYSTEM_LENGTH)),
        liftOff: hex(await wire.read(P.ADDR.liftOff, 2)),
        paw3955Dpi: allStages,
        function: hex(await wire.read(P.ADDR.function, P.FUNCTION_LENGTH)),
        performance: hex(await wire.read(P.ADDR.performance, P.PERFORMANCE_LENGTH)),
        angle: hex(await wire.read(P.ADDR.angle, 4)),
        buttons: await readButtonRows(wire),
      },
    },
    null,
    1,
  );
  await save(BACKUP_PREFIX, json);
}

/** The six button rows, as read; part of every backup so a later button change can be put back. */
async function readButtonRows(wire: Wire): Promise<string[]> {
  const rows: string[] = [];
  for (let i = 0; i < P.KEY_ROW.count; i++) rows.push(hex(await wire.read(P.keyRowAddress(i), P.KEY_ROW.length)));
  return rows;
}

function checkStages(values: number[], active: number, range: AtkView["dpiRange"]) {
  if (!values.length || values.length > range.maxStages) throw new Error(`Use 1 to ${range.maxStages} DPI steps.`);
  for (const v of values) {
    if (!Number.isInteger(v) || v < range.min || v > range.max) throw new Error(`${v} DPI is outside ${range.min}–${range.max}.`);
  }
  if (!Number.isInteger(active) || active < 0 || active >= values.length) throw new Error("Pick which step the mouse should run.");
}

/** Opens one ATK receiver or cable and reads the mouse. `save` is where backups go. */
export async function connectAtkDevice(device: HIDDevice, save: Save, opts: { wait?: (ms: number) => Promise<void> } = {}): Promise<AtkSession> {
  await device.open();
  // The gate holds this mouse's Advanced tokens; the wire's checkFrame reads it (atk-protocol.ts), and the
  // bridge is asked for the same grant (src-tauri/src/hid.rs).
  const gate = new AdvancedGate(`atk:${device.productId.toString(16)}`, nativeOf(device));
  const wire = new Wire(device, gate);

  let id: Identity;
  let rows: Rows;
  let view: AtkView;
  try {
    id = await identify(wire, device.productId);
    rows = await readRows(wire);
    view = toView(id, rows, await wire.command(P.CMD.getBattery).catch(() => null));
    if (view.writable) rememberAtk(device, view.name, rows, view);
  } catch (e) {
    await device.close().catch(() => undefined);
    throw e;
  }
  let backedUp = false;

  const reread = async () => {
    rows = await readRows(wire);
    view = toView(id, rows, await wire.command(P.CMD.getBattery).catch(() => null));
    // What the Games page builds profiles from (src/lib/profiles): kept, not read again for it.
    if (view.writable) rememberAtk(device, view.name, rows, view);
    session.view = view;
    return view;
  };
  /** Every change goes through here: writable check, one backup per session, then the change. */
  const change = async (work: () => Promise<void>) => {
    if (!view.writable) throw new Error(view.readOnlyReason ?? "This mouse can't be changed from SYNQ yet.");
    if (!backedUp) {
      await backup(wire, id, save);
      backedUp = true;
    }
    await work();
    return reread();
  };
  /** Rewrites the system row (rate, step count, active step); bytes 6-9 stay exactly as read. */
  const writeSystem = async (patch: { pollingCode?: number; stageCount?: number; activeStage?: number }) => {
    let row = await wire.read(P.ADDR.system, P.SYSTEM_LENGTH);
    P.decodeSystem(row);
    if (patch.pollingCode !== undefined) row = P.withPair(row, 0, patch.pollingCode);
    if (patch.stageCount !== undefined) row = P.withPair(row, 2, patch.stageCount);
    if (patch.activeStage !== undefined) row = P.withPair(row, 4, patch.activeStage);
    await wire.writeRow(P.ADDR.system, row);
  };
  const writeStages = async (values: number[]) => {
    for (let i = 0; i < values.length; i++) {
      const address = P.ADDR.paw3955Dpi + i * P.PAW3955_STAGE_LENGTH;
      const current = await wire.read(address, P.PAW3955_STAGE_LENGTH);
      const stored = P.unpackPaw3955Stage(current);
      // Leave a step alone when it already runs this value (it may carry a separate Y from ATK HUB).
      if (stored.x === values[i] && stored.y === values[i]) continue;
      await wire.writeRow(address, P.packPaw3955Stage(values[i]));
    }
  };
  const patchFunction = (offset: number, value: number) =>
    change(async () => {
      const row = await wire.read(P.ADDR.function, P.FUNCTION_LENGTH);
      P.decodeFunction(row);
      await wire.writeRow(P.ADDR.function, P.withPair(row, offset, value));
    });

  const session: AtkSession = {
    view,
    refresh: reread,
    async saveStages(values, active) {
      checkStages(values, active, view.dpiRange);
      return change(async () => {
        await writeStages(values);
        // ATK HUB re-sends the system row after DPI rows, which also re-applies the active step.
        await writeSystem({ stageCount: values.length, activeStage: active });
      });
    },
    async setActiveDpi(dpi) {
      const existing = view.stages.indexOf(dpi);
      const values = existing >= 0 ? view.stages : view.stages.map((x, i) => (i === view.activeStage ? dpi : x));
      const v = await session.saveStages(values, existing >= 0 ? existing : view.activeStage);
      if (v.dpi !== dpi) throw new Error(`Saved ${dpi} DPI, but the mouse reports ${v.dpi}.`);
      return v;
    },
    async setPolling(hz) {
      const code = P.codeForRate(hz);
      if (code === null || !view.pollingOptions.includes(hz)) throw new Error(`${hz} Hz isn't available on this connection.`);
      return change(() => writeSystem({ pollingCode: code }));
    },
    async setLiftOff(mm) {
      const code = P.liftOffCode(mm);
      if (code < P.LIFT_OFF.minCode || code > P.LIFT_OFF.maxCode) throw new Error(`Lift-off runs ${P.LIFT_OFF.minMm} to ${P.LIFT_OFF.maxMm} mm.`);
      return change(() => wire.writeRow(P.ADDR.liftOff, P.pair(code)));
    },
    setAngleSnapping: (on) => patchFunction(P.FN.angleSnapping, on ? 1 : 0),
    setRippleControl: (on) => patchFunction(P.FN.rippleControl, on ? 1 : 0),
    setMotionSync: (on) => patchFunction(P.FN.motionSync, on ? 1 : 0),
    setDebounce: (ms) => {
      if (!view.debounceOptions.includes(ms)) return Promise.reject(new Error(`${ms} ms debounce isn't offered for this mouse.`));
      return patchFunction(P.FN.debounce, ms);
    },
    setSensorMode: (mode) =>
      change(async () => {
        if (!P.SENSOR_MODES.some((m) => m.value === mode)) throw new Error("Unknown sensor mode.");
        const row = await wire.read(P.ADDR.performance, P.PERFORMANCE_LENGTH);
        if (P.decodeSensorMode(row) === null) throw new Error("The mouse reported a sensor mode SYNQ doesn't recognise, so it left it alone.");
        await wire.writeRow(P.ADDR.performance, P.withPair(row, P.PERF.sensorMode, mode));
      }),
    advanced: atkAdvanced({
      wire,
      gate,
      cid: Number(id.cidMid.split(",")[0]),
      mid: Number(id.cidMid.split(",")[1]),
      deviceName: id.model.name,
      wireless: id.link.wireless,
      writable: view.writable,
      firmware: id.firmware,
      receiverFirmware: id.receiverFirmware,
      save,
      wait: opts.wait,
      // The panel reads the mouse again itself once an Advanced action is done (session.refresh()).
      refresh: async () => {},
    }),
    close: async () => {
      await gate.revokeAll().catch(() => undefined);
      await device.close();
    },
  };
  return session;
}
