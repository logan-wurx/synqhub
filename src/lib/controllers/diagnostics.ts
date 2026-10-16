// "Save diagnostics" for a controller (CONTROLLERS-ROADMAP.md P4): what the pad is, how it's reached, its report
// layout as the bridge (or the browser) read it from the descriptor, 3 s of its input reports, the allowlisted reads
// SYNQ made and the firmware it reported. Nothing is sent to the pad to make it. Bluetooth and pairing addresses
// never get here: the parsers drop them (parse.ts), Switch replies are redacted before they're kept (link.ts), and
// Sony's address reports are never read. As a last check every MAC-shaped text is masked.
import type { Connected } from "../backend";
import type { PadIdentity } from "./identify";
import type { PadInfo, PadLink, RawReport } from "./link";
import { pollingStats } from "./analysis.ts";

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

/** Masks anything that looks like a Bluetooth address ("aa:bb:cc:dd:ee:ff", "aa-bb-...", "aabbccddeeff" after a "mac"). */
export function maskAddresses(text: string): string {
  return text
    .replace(/\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, "xx:xx:xx:xx:xx:xx")
    .replace(/("(?:mac|address|bdaddr|bt_?addr)"\s*:\s*")[^"]*"/gi, '$1xx:xx:xx:xx:xx:xx"');
}

export interface PadDiagnostics {
  kind: "controller-diagnostics";
  savedAt: string;
  app: "SYNQ";
  note: string;
  identity: Pick<PadIdentity, "name" | "brand" | "kind" | "transport" | "personality" | "via" | "support" | "settings"> & { model: string | null; vid: string; pid: string; mismatch: string | null };
  listed: { name: string; reported: string | null; connection: string; collections?: Connected["collections"]; pad?: Connected["pad"] };
  descriptor: unknown;
  info: Omit<PadInfo, "reads">;
  reads: PadInfo["reads"];
  source: PadLink["source"];
  reports: { t: number; id: number; hex: string }[];
  polling: ReturnType<typeof pollingStats>;
  conflicts: string[];
}

/** Records `seconds` of the pad's input reports and puts the bundle together. */
export async function collectDiagnostics(link: PadLink, device: Connected, descriptor: unknown, conflicts: string[], seconds = 3): Promise<PadDiagnostics> {
  const reports: RawReport[] = [];
  const off = link.onRaw((r) => reports.push(r));
  // XInput has no raw reports: its sampler's changes stand in for them.
  const measured = link.source.kind === "hid" ? await new Promise<null>((r) => setTimeout(() => r(null), seconds * 1000)) : await link.measure(seconds);
  off();
  const id = link.identity;
  const { reads, ...info } = link.info;
  const times = measured ? measured.times : reports.map((r) => r.t);
  return {
    kind: "controller-diagnostics",
    savedAt: new Date().toISOString(),
    app: "SYNQ",
    note: "Read-only export: nothing was sent to the controller to make this file. Bluetooth addresses are left out.",
    identity: {
      name: id.name,
      brand: id.brand,
      kind: id.kind,
      transport: id.transport,
      personality: id.personality,
      via: id.via,
      support: id.support,
      settings: id.settings,
      model: id.model?.id ?? null,
      vid: id.vid.toString(16).padStart(4, "0"),
      pid: id.pid.toString(16).padStart(4, "0"),
      mismatch: id.mismatch,
    },
    listed: { name: device.name, reported: device.reported, connection: device.connection, collections: device.collections, pad: device.pad },
    descriptor,
    info,
    reads,
    source: link.source,
    reports: measured
      ? measured.states.slice(0, 4000).map((s) => ({ t: Math.round(s.t * 1000) / 1000, id: 0, hex: JSON.stringify({ sticks: s.sticksRaw ?? s.sticks, triggers: s.triggersRaw ?? s.triggers, buttons: Object.keys(s.buttons).filter((b) => s.buttons[b as keyof typeof s.buttons]) }) }))
      : reports.slice(0, 4000).map((r) => ({ t: Math.round(r.t * 1000) / 1000, id: r.id, hex: hex(r.data) })),
    polling: pollingStats(times, { warmupMs: 0 }),
    conflicts,
  };
}

/** The bundle as the text that is saved. */
export function diagnosticsText(d: PadDiagnostics): string {
  return maskAddresses(JSON.stringify(d, null, 1));
}

/** The file name a bundle gets ("sony-dualsense", "pad-3537-1010"). */
export const diagnosticsName = (identity: PadIdentity) => (identity.model?.id ?? `pad-${identity.vid.toString(16)}-${identity.pid.toString(16)}`).replace(/[^a-z0-9-]/gi, "-");
