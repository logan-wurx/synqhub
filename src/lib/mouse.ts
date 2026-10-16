// Mouse service: connects OpenMouse's Logitech HID++ driver through the Tauri HID bridge and
// exposes the handful of things the Mouse page edits. Every change is written into the mouse's
// active onboard profile (flash), so it survives power cycles and works on cable or receiver.
// The profiles are backed up once per session before the first write.
import { invoke } from "@tauri-apps/api/core";
import { LogitechHidppClient } from "@openmouse/protocol/drivers/logitech/hidpp";
import {
  capabilitiesForFormat,
  dpiStageCapabilitiesForOptions,
  reportRateCapabilitiesFor,
  validateDpiStagePlan,
  type DpiStage,
  type DpiStageCapabilities,
  type OnboardProfile,
} from "@openmouse/protocol/drivers/logitech/onboard-profiles";
import { liveHardware } from "./backend";
import { installTauriHid } from "./tauri-hid";

export type Lod = "Low" | "Medium" | "High";
const LOD_LEVEL: Record<Lod, number> = { Low: 1, Medium: 2, High: 3 };
const LOD_NAME: Record<number, Lod> = { 1: "Low", 2: "Medium", 3: "High" };
const RATES = [125, 250, 500, 1000, 2000, 4000, 8000];

export interface MouseView {
  name: string;
  connection: "Wired" | "Wireless";
  connectionDetail: string;
  batteryPercent: number | null;
  batteryState: string;
  firmware: string[];
  dpi: number;
  /** Onboard means the mouse runs from its own memory; Host means software is driving it live. */
  mode: "Onboard" | "Host" | "Unknown";
  writable: boolean;
  formatName: string | null;
  stages: number[];
  defaultStage: number;
  lod: Lod | null;
  lods: Lod[];
  /** Rate shown and set: the wireless one, since that is how the mouse is mostly used. */
  pollingHz: number;
  pollingWiredHz: number | null;
  pollingOptions: number[];
  wirelessMaxHz: number | null;
  wiredMaxHz: number | null;
  caps: DpiStageCapabilities | null;
}

export interface MouseSession {
  view: MouseView;
  refresh(): Promise<MouseView>;
  saveStages(stages: number[], defaultStage: number): Promise<MouseView>;
  setPolling(hz: number): Promise<MouseView>;
  setLod(lod: Lod): Promise<MouseView>;
  useOnboard(): Promise<MouseView>;
  /** Reloads the stored profile so the mouse runs what is saved. */
  applySaved(): Promise<MouseView>;
  /** Sets the DPI the mouse runs: the starred step's value, saved and applied. */
  setActiveDpi(dpi: number): Promise<MouseView>;
  close(): Promise<void>;
}

const usedStages = (p: OnboardProfile) => p.dpiStages.filter((s) => s.lod !== 0 && s.x > 0);

/**
 * In onboard mode the firmware runs a DPI-stage pointer of its own (0x8100 fn 0x0B/0x0C, "current
 * DPI index" in libratbag), separate from the profile's default-index byte. Re-selecting the same
 * profile, toggling host/onboard, or a power cycle all left a PRO X 2 DEX (format 7, MPM 37.03) on
 * its old stage while the stored default pointed elsewhere. So the starred step is kept first in the
 * profile, which covers boot, and the pointer is set directly, which applies it now. Volatile, no flash.
 */
const ONBOARD_PROFILES = 0x8100;
const GET_DPI_INDEX = 0xb0;
const SET_DPI_INDEX = 0xc0;
type HidppRaw = {
  getFeature(id: number): Promise<{ index: number }>;
  request(featureIndex: number, functionId: number, ...params: number[]): Promise<Uint8Array>;
};

async function selectDpiStage(client: LogitechHidppClient, index: number) {
  // The driver keeps these two private; they are the plain HID++ request path it uses itself.
  const raw = client as unknown as HidppRaw;
  const { index: feature } = await raw.getFeature(ONBOARD_PROFILES);
  if (!feature) throw new Error("This mouse does not expose onboard-profile controls.");
  await raw.request(feature, SET_DPI_INDEX, index);
  const now = (await raw.request(feature, GET_DPI_INDEX))[3];
  if (now !== index) throw new Error(`The mouse stayed on DPI step ${now + 1} instead of step ${index + 1}.`);
}

/** The starred step moves to slot 0 (the rest keep their order), so it is also what the mouse boots on. */
function starFirst(stages: DpiStage[], star: number) {
  const s = Math.min(Math.max(star, 0), stages.length - 1);
  return { stages: [stages[s], ...stages.filter((_, i) => i !== s)], defaultIndex: 0 };
}

async function backupOnce(client: LogitechHidppClient, done: { value: boolean }) {
  if (done.value) return;
  const profiles = await client.readOnboardProfiles();
  const json = JSON.stringify(
    { savedAt: new Date().toISOString(), profiles: profiles.map((p) => ({ ...p, raw: Array.from(p.raw) })) },
    null,
    1,
  );
  await invoke("mouse_backup_save", { json });
  done.value = true;
}

async function readView(client: LogitechHidppClient): Promise<{ view: MouseView; profile: OnboardProfile | null }> {
  const status = await client.readStatus();
  const formatId = status.onboardProfileFormat?.id ?? null;
  const profiles = status.onboardProfileFormat?.supported ? await client.readOnboardProfiles().catch(() => []) : [];
  const profile = profiles.find((p) => p.isCurrent) ?? null;
  const stages = profile ? usedStages(profile) : [];
  const caps = dpiStageCapabilitiesForOptions(capabilitiesForFormat(formatId).dpiStages, await client.getDpiOptions().catch(() => []));
  const rateCaps = reportRateCapabilitiesFor(formatId, status.transportIds?.USB ?? null);
  const ceiling = status.connectionType === "Wired" ? rateCaps?.wiredMaxHz : rateCaps?.wirelessMaxHz;
  const fromStatus = status.supportedPollingRates ?? [];
  const pollingOptions = (rateCaps ? RATES.filter((r) => r <= Math.max(rateCaps.wirelessMaxHz, rateCaps.wiredMaxHz)) : fromStatus).filter(
    (r) => fromStatus.length === 0 || fromStatus.includes(r) || (ceiling !== undefined && r > ceiling),
  );
  const defaultIndex = profile?.defaultDpiIndex ?? 0;
  const lodLevel = stages[defaultIndex]?.lod ?? stages[0]?.lod;
  const view: MouseView = {
    name: status.name,
    connection: status.connectionType ?? "Wireless",
    connectionDetail: status.connectionDetail ?? "",
    batteryPercent: status.batteryPercent,
    batteryState: status.batteryState,
    // The bootloader is listed first; the running firmware is what matters.
    firmware: [...status.firmware].sort((a, b) => Number(/^(BL|BOT)/i.test(a)) - Number(/^(BL|BOT)/i.test(b))),
    dpi: status.dpi,
    mode: status.deviceMode ?? "Unknown",
    writable: Boolean(status.onboardProfileFormat?.writable && profile),
    formatName: status.onboardProfileFormat?.name ?? null,
    stages: stages.map((s) => s.x),
    defaultStage: Math.min(defaultIndex, Math.max(0, stages.length - 1)),
    lod: lodLevel ? LOD_NAME[lodLevel] ?? null : status.liftOffDistance,
    lods: (status.supportedLiftOffDistances?.length ? status.supportedLiftOffDistances : capabilitiesForFormat(formatId).supportedLods) as Lod[],
    pollingHz: profile?.reportRateWireless ?? status.pollingRateHz,
    pollingWiredHz: profile?.reportRateWired ?? null,
    pollingOptions: pollingOptions.length ? pollingOptions : [status.pollingRateHz],
    wirelessMaxHz: rateCaps?.wirelessMaxHz ?? null,
    wiredMaxHz: rateCaps?.wiredMaxHz ?? null,
    caps,
  };
  return { view, profile };
}

export async function connectMouse(): Promise<MouseSession | null> {
  if (!liveHardware) return previewSession();
  await installTauriHid();
  const client = await LogitechHidppClient.reconnectAuthorizedReceiver();
  if (!client) return null;
  const backedUp = { value: false };
  let { view, profile } = await readView(client);

  const reread = async () => {
    ({ view, profile } = await readView(client));
    session.view = view;
    return view;
  };
  /**
   * Writing the profile only changes flash. Re-selecting the profile (kept for the report rate) does
   * not move the firmware's DPI-stage pointer, so the starred step is selected directly. Volatile.
   */
  const runStarred = async () => {
    await reread();
    if (profile && view.mode === "Onboard" && view.stages.length) await selectDpiStage(client, view.defaultStage);
    return reread();
  };
  const applyProfile = async (sector: number) => {
    await client.setCurrentProfile(sector);
    return runStarred();
  };
  const needWritable = () => {
    if (!view.writable || !profile) throw new Error("This mouse's onboard profile can't be written yet.");
    if (view.mode === "Host") throw new Error("The mouse is in host mode. Switch it to onboard memory first.");
    return profile;
  };

  const session: MouseSession = {
    view,
    refresh: reread,
    async saveStages(values, defaultStage) {
      const p = needWritable();
      const current = usedStages(p);
      const lod = current[0]?.lod || LOD_LEVEL[view.lod ?? "Low"];
      const stages: DpiStage[] = values.map((x, i) => ({ x, y: x, lod: current[i]?.lod || lod }));
      const plan = starFirst(stages, defaultStage);
      const problem = validateDpiStagePlan(plan, view.caps);
      if (problem) throw new Error(problem);
      await backupOnce(client, backedUp);
      await client.setProfileDpiStages(plan);
      return applyProfile(p.sector);
    },
    async setPolling(hz) {
      const p = needWritable();
      await backupOnce(client, backedUp);
      // Wireless and wired keep separate rates in the profile; set both so the choice holds on either.
      const wired = view.wiredMaxHz ? RATES.filter((r) => r <= Math.min(hz, view.wiredMaxHz!)).pop() ?? hz : hz;
      const wireless = view.wirelessMaxHz ? RATES.filter((r) => r <= Math.min(hz, view.wirelessMaxHz!)).pop() ?? hz : hz;
      await client.writeActiveProfile({ reportRateWirelessHz: wireless, reportRateWiredHz: wired });
      return applyProfile(p.sector);
    },
    async setLod(lod) {
      const p = needWritable();
      const current = usedStages(p);
      if (!current.length) throw new Error("No DPI steps to apply lift-off to.");
      await backupOnce(client, backedUp);
      await client.setProfileDpiStages({
        stages: current.map((s) => ({ ...s, lod: LOD_LEVEL[lod] })),
        defaultIndex: Math.min(p.defaultDpiIndex ?? 0, current.length - 1),
      });
      return applyProfile(p.sector);
    },
    async useOnboard() {
      await client.setOnboardMode("Onboard");
      // Back in onboard mode the firmware resumes its old stage pointer, not the starred step.
      return runStarred();
    },
    applySaved() {
      return applyProfile(needWritable().sector);
    },
    async setActiveDpi(dpi) {
      const p = needWritable();
      const current = usedStages(p);
      const lod = current[0]?.lod || LOD_LEVEL[view.lod ?? "Low"];
      const index = current.length ? Math.min(p.defaultDpiIndex ?? 0, current.length - 1) : 0;
      // A value that is already a step just gets the star; otherwise the starred step takes the value.
      const existing = current.findIndex((st) => st.x === dpi && st.y === dpi);
      const plan = !current.length
        ? { stages: [{ x: dpi, y: dpi, lod }], defaultIndex: 0 }
        : existing >= 0
          ? starFirst(current, existing)
          : starFirst(current.map((st, i) => (i === index ? { ...st, x: dpi, y: dpi } : st)), index);
      const problem = validateDpiStagePlan(plan, view.caps);
      if (problem) throw new Error(problem);
      await backupOnce(client, backedUp);
      await client.setProfileDpiStages(plan);
      const v = await applyProfile(p.sector);
      if (v.dpi !== dpi) throw new Error(`Saved ${dpi} DPI, but the mouse is still running ${v.dpi}.`);
      return v;
    },
    close: () => client.close(),
  };
  return session;
}

/** Sample mouse for the browser preview. Nothing here touches hardware. */
function previewSession(): MouseSession {
  let view: MouseView = {
    name: "PRO X 2 DEX",
    connection: "Wired",
    connectionDetail: "USB cable",
    batteryPercent: 84,
    batteryState: "Charging",
    firmware: ["MPM 31.00 B0011"],
    dpi: 800,
    mode: "Onboard",
    writable: true,
    formatName: "Superlight 2 (format 7)",
    stages: [400, 800, 1600, 3200],
    defaultStage: 1,
    lod: "Low",
    lods: ["Low", "Medium", "High"],
    pollingHz: 2000,
    pollingWiredHz: 1000,
    pollingOptions: [125, 250, 500, 1000, 2000, 4000, 8000],
    wirelessMaxHz: 8000,
    wiredMaxHz: 8000,
    caps: { maxStages: 5, minDpi: 100, maxDpi: 44000, stepDpi: 50 },
  };
  const wait = () => new Promise((r) => setTimeout(r, 250));
  const session: MouseSession = {
    view,
    refresh: async () => view,
    async saveStages(stages, defaultStage) {
      await wait();
      view = { ...view, stages, defaultStage, dpi: stages[defaultStage] };
      return (session.view = view);
    },
    async setPolling(hz) {
      await wait();
      view = { ...view, pollingHz: hz };
      return (session.view = view);
    },
    async setLod(lod) {
      await wait();
      view = { ...view, lod };
      return (session.view = view);
    },
    async useOnboard() {
      view = { ...view, mode: "Onboard" };
      return (session.view = view);
    },
    async applySaved() {
      view = { ...view, dpi: view.stages[view.defaultStage] };
      return (session.view = view);
    },
    async setActiveDpi(dpi) {
      await wait();
      view = { ...view, dpi, stages: view.stages.map((x, i) => (i === view.defaultStage ? dpi : x)) };
      return (session.view = view);
    },
    close: async () => {},
  };
  return session;
}
