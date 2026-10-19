// The Lights view (wave L5, "one look everywhere"): every light SYNQ drives, Govee, Wi-Fi, Dynamic Lighting and USB
// hubs alike, in groups the person names, and one look (a colour, a white or a gradient, a brightness, on or off) sent to
// a group or to all of them. Each light keeps its own guard and pace (src/lib/lighting/look). Lights are opened while
// this view is open and the window is in use, and let go when it closes; a hub takes changes only once allowed here,
// as on its own page; a Dynamic Lighting device takes them only while SYNQ is in front (Windows' rule).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import type { Connected } from "@/lib/backend";
import { inTauri, isWeb } from "@/lib/backend";
import { useWindowActive } from "@/lib/activity";
import { useLampScan } from "@/lib/lighting/lamps";
import { useNetLights } from "@/lib/lighting/net/lights";
import { useLampArrays } from "@/lib/lighting/lamparrays";
import { findHub } from "@/lib/lighting/hidrgb/protocol";
import { LookControl, type Driver } from "@/lib/lighting/look/control";
import { openDriver } from "@/lib/lighting/look/drivers";
import { lightRefs, type LightRef } from "@/lib/lighting/look/lights";
import { forgetGroup, rgbOf, saveGroup, useLightingKeep } from "@/lib/lighting/saved";
import { ALL_LAMPS, GOVEE_TOGETHER } from "@/lib/lighting/models";
import { useKeptState } from "@/lib/keep";
import { lightId, openDevice, useDeviceTab } from "@/lib/nav";
import { useWide } from "@/lib/viewport";
import { cn } from "@/lib/utils";
import { Card, CardHeader, type Notice } from "@/components/ui/matte";
import { DeviceArt, lightArt, netLightArt, type ArtSpec } from "@/components/devices/DeviceArt";
import { DeviceFrame, DeviceHeader, StatusPill, TAB_BODY, type TabDef } from "@/components/devices/shell";
import { LightTab } from "./LightTab";
import { Chip, PowerButton, SubHead } from "./controls";
import { FindLights } from "./FindLights";
import { LightsSync } from "./LightsSync";

// Screen sync reads the screen in the desktop app, or on the website in SYNQ Helper (the tab says so until it's connected).
const TABS: TabDef[] = [
  { id: "look", label: "Look" },
  { id: "sync", label: "Screen sync" },
];
const ALL = "all";

type Notify = (n: Omit<Notice, "id">, key?: string) => void;

/** Ready-made gradients, then the person's own (kept in lighting.json). */
const GRADIENTS: readonly { name: string; stops: readonly string[] }[] = [
  { name: "Sunset", stops: ["#ff5e3a", "#ff2a7a", "#8a2aff"] },
  { name: "Aurora", stops: ["#00e5a0", "#00b3ff", "#8a2aff"] },
  { name: "Ember", stops: ["#ff2a00", "#ff8a00", "#ffd400"] },
  { name: "Ocean", stops: ["#00e5ff", "#2a5bff", "#0b1f6b"] },
];

function artOf(r: LightRef): ArtSpec {
  if (r.source === "govee") return lightArt(r.lamp.sku);
  if (r.source === "wifi") return netLightArt(r.device);
  if (r.source === "lamparray") return { kind: "lamparray", family: r.device.id, name: r.name, brand: "Dynamic Lighting" };
  const [vid, pid] = r.family.split(":");
  return { kind: "rgbhub", family: r.family, name: r.name, brand: "", vid, pid };
}

const pageOf = (r: LightRef) => (r.source === "govee" ? lightId(r.lamp.id) : r.source === "wifi" ? lightId(r.key.slice(5)) : r.source === "lamparray" ? `dl:${r.device.id}` : `rgb:${r.family}`);

type Status = "opening" | "ready" | { why: string } | "waiting";

export function LightsView({ devices, notify }: { devices: readonly Connected[]; notify: Notify }) {
  const lamps = useLampScan();
  const net = useNetLights();
  const lampArrays = useLampArrays() ?? [];
  const hubs = useMemo(
    () => devices.flatMap((d) => (d.kind === "rgbhub" && findHub(d.vid, d.pid) ? [{ family: `${d.vid}:${d.pid}`, model: findHub(d.vid, d.pid)! }] : [])),
    [devices],
  );
  const refs = useMemo(() => lightRefs(lamps, net, lampArrays, hubs), [lamps, net, lampArrays, hubs]);
  const keep = useLightingKeep();
  const [groupId, setGroupId] = useKeptState<string>("lights.group", ALL);
  const group = keep.groups.find((g) => g.id === groupId) ?? null;
  const members = group ? refs.filter((r) => group.members.includes(r.key)) : refs;
  const [editing, setEditing] = useState<{ id: string; name: string; members: string[] } | null>(null);
  // Hubs take changes only once allowed here (for this visit), as on their own pages.
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(new Set());

  const look = useMemo(() => new LookControl(), []);
  const view = useSyncExternalStore(look.subscribe, look.getView);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const active = useWindowActive();
  // Bluetooth lamps are let go while the window is in the background (the bridge would close them anyway; the website
  // lets go of its own the same way).
  const background = (inTauri || isWeb) && !active;
  const wanted = members.filter((r) => r.source !== "hub" || allowed.has(r.family)).map((r) => r.key);
  const wantedKey = background ? "" : wanted.join();
  const refsNow = useRef(refs);
  refsNow.current = refs;

  // Opens the lights the look goes to, and lets go of the ones that left it.
  useEffect(() => {
    let live = true;
    const opened = new Map<string, Driver>();
    const keys = wantedKey ? wantedKey.split(",") : [];
    setStatus(Object.fromEntries(keys.map((k) => [k, "opening" as Status])));
    for (const key of keys) {
      const ref = refsNow.current.find((r) => r.key === key);
      if (!ref) continue;
      openDriver(ref, (family) => allowed.has(family)).then(
        (d) => {
          if (!live) return void d.close();
          opened.set(key, d);
          look.setDrivers([...opened.values()]);
          setStatus((s) => ({ ...s, [key]: "ready" }));
        },
        (e: unknown) => live && setStatus((s) => ({ ...s, [key]: { why: e instanceof Error ? e.message : String(e) } })),
      );
    }
    return () => {
      live = false;
      look.setDrivers([]);
      void Promise.allSettled([...opened.values()].map((d) => d.close()));
    };
    // `wantedKey` stands for the members (and the window being in use); `allowed` is part of it through the hubs.
  }, [wantedKey, look]); // eslint-disable-line react-hooks/exhaustive-deps

  const wide = useWide();
  const [tab, setTab] = useDeviceTab(lightId(ALL_LAMPS), TABS.map((t) => t.id));
  const goveeCount = refs.filter((r) => r.source === "govee").length;
  const reached = members.filter((r) => status[r.key] === "ready").length;

  const memberList = (
    <Card innerClassName="pb-4">
      <CardHeader
        title={editing ? "Lights in this group" : group ? group.name : "All lights"}
        hint={editing ? "Tap a light to add it or take it out." : `${members.length} ${members.length === 1 ? "light" : "lights"}${background ? " · let go while SYNQ is in the background" : ""}`}
      />
      <div className="mt-3 flex flex-col gap-1.5 px-3">
        {(editing ? refs : members).map((r) => (
          <LightRow
            key={r.key}
            r={r}
            status={editing ? undefined : status[r.key]}
            picked={editing ? editing.members.includes(r.key) : undefined}
            onPick={editing ? () => setEditing({ ...editing, members: editing.members.includes(r.key) ? editing.members.filter((m) => m !== r.key) : [...editing.members, r.key] }) : undefined}
            allowHub={r.source === "hub" && !editing ? { on: allowed.has(r.family), set: (on) => setAllowed((s) => (on ? new Set([...s, r.family]) : new Set([...s].filter((f) => f !== r.family)))) } : undefined}
          />
        ))}
        {refs.length === 0 && <p className="px-2 py-3 text-[12.5px] text-medium">No lights yet. Lamps in Bluetooth range show up by themselves; Wi-Fi lights after Find lights.</p>}
      </div>
      {!editing && (
        <div className="mt-3 flex flex-wrap items-center gap-2 px-5">
          {!isWeb && <FindLights />}
          {goveeCount > 1 && (
            <button type="button" onClick={() => openDevice(lightId(GOVEE_TOGETHER))} className="text-[12.5px] text-medium underline-offset-4 hover:text-high hover:underline">
              Govee lamps together: scenes, effects, music
            </button>
          )}
        </div>
      )}
    </Card>
  );

  const lookTab = (
    <>
      {members.some((r) => r.source === "lamparray") && (
        <p className="px-1 text-[12.5px] text-medium">Dynamic Lighting devices take colours only while SYNQ is in front (Windows' rule).</p>
      )}
      <LightTab control={look} view={view} group />
      <Card innerClassName="pb-5">
        <CardHeader title="Gradient" hint="Spread across each light from its first segment to its last; a light of one colour takes the middle." />
        <div className="mt-4 flex flex-wrap gap-2 px-5">
          {[...GRADIENTS, ...keep.gradients.map((stops, i) => ({ name: `Saved ${i + 1}`, stops }))].map((g) => (
            <button
              key={g.name}
              type="button"
              onClick={() => look.setGradient(g.stops.map(rgbOf))}
              className="flex items-center gap-2 rounded-full bg-white/[0.04] py-1 pl-1 pr-3 text-[12.5px] text-medium ring-1 ring-white/[0.08] transition-colors hover:bg-white/[0.08] hover:text-high"
            >
              <span className="h-5 w-10 rounded-full ring-1 ring-white/15" style={{ background: `linear-gradient(to right, ${g.stops.join(", ")})` }} />
              {g.name}
            </button>
          ))}
        </div>
      </Card>
    </>
  );

  const body = (
    <>
      <GroupBar
        groups={keep.groups}
        value={group ? group.id : ALL}
        editing={editing}
        onPick={(id) => setGroupId(id)}
        onNew={() => setEditing({ id: `g${Date.now().toString(36)}`, name: "", members: [] })}
        onEdit={() => group && setEditing({ ...group, members: [...group.members] })}
        onName={(name) => editing && setEditing({ ...editing, name })}
        onSave={() => {
          if (!editing) return;
          saveGroup({ ...editing, name: editing.name.trim() || "My lights" });
          setGroupId(editing.id);
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
        onDelete={() => {
          if (!group) return;
          forgetGroup(group.id);
          setGroupId(ALL);
          setEditing(null);
        }}
      />
      {tab === "sync" ? (
        <LightsSync members={members} look={look} reached={(k) => status[k] === "ready"} onError={(why) => notify({ tone: "error", title: "Screen sync didn't start", detail: why }, "lights-sync")} />
      ) : (
        lookTab
      )}
    </>
  );

  return (
    <DeviceFrame
      header={
        <DeviceHeader
          id={lightId(ALL_LAMPS)}
          name="All lights"
          pills={<StatusPill live={reached > 0}>{members.length ? `${reached} of ${members.length} reached` : "No lights"}</StatusPill>}
          subtitle={isWeb ? "One look for every lamp added in this tab, in groups you name." : "One look for every light: Govee, Wi-Fi, Dynamic Lighting and USB hubs, in groups you name."}
          actions={<PowerButton on={view.power !== false} onClick={() => look.setPower(view.power === false)} />}
          tabs={TABS}
          tab={tab}
          onTab={setTab}
        />
      }
      aside={memberList}
    >
      <div className={TAB_BODY} tabIndex={0} data-testid="lights-view">
        {wide ? (
          body
        ) : (
          <div className="grid grow grid-cols-[minmax(260px,320px)_minmax(0,1fr)] gap-5">
            {memberList}
            <div className="flex min-w-0 flex-col gap-5">{body}</div>
          </div>
        )}
      </div>
    </DeviceFrame>
  );
}

function LightRow({
  r,
  status,
  picked,
  onPick,
  allowHub,
}: {
  r: LightRef;
  status?: Status;
  picked?: boolean;
  onPick?: () => void;
  allowHub?: { on: boolean; set: (on: boolean) => void };
}) {
  const failed = typeof status === "object" ? status.why : null;
  const inner = (
    <>
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-control bg-white/[0.03] ring-1 ring-white/[0.06]">
        <DeviceArt spec={artOf(r)} className="max-h-8 max-w-8" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-high">{r.name}</span>
        <span className="block truncate text-[11.5px] text-medium" title={failed ?? undefined}>
          {failed ? `Not reached: ${failed}` : r.detail}
        </span>
      </span>
      {picked !== undefined ? (
        <span className={cn("grid size-5 shrink-0 place-items-center rounded-[5px] ring-1", picked ? "bg-primary text-primary-foreground ring-primary" : "ring-white/20")}>{picked && <Check size={12} weight="bold" />}</span>
      ) : (
        <span className={cn("size-1.5 shrink-0 rounded-full", status === "ready" ? "bg-live" : failed ? "bg-destructive" : "bg-asleep")} aria-hidden="true" />
      )}
    </>
  );
  return (
    <div className="flex items-center gap-2">
      {onPick ? (
        <button type="button" onClick={onPick} aria-pressed={picked} className="flex min-w-0 flex-1 items-center gap-3 rounded-small px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]">
          {inner}
        </button>
      ) : (
        <button type="button" onClick={() => openDevice(pageOf(r))} className="flex min-w-0 flex-1 items-center gap-3 rounded-small px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]" title="Open its own page">
          {inner}
        </button>
      )}
      {allowHub && (
        <Chip small on={allowHub.on} onClick={() => allowHub.set(!allowHub.on)}>
          {allowHub.on ? "Changes allowed" : "Allow changes"}
        </Chip>
      )}
    </div>
  );
}

/** All lights, the person's groups, and making or changing one. */
function GroupBar({
  groups,
  value,
  editing,
  onPick,
  onNew,
  onEdit,
  onName,
  onSave,
  onCancel,
  onDelete,
}: {
  groups: readonly { id: string; name: string }[];
  value: string;
  editing: { id: string; name: string } | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onEdit: () => void;
  onName: (name: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  if (editing)
    return (
      <Card innerClassName="flex flex-wrap items-center gap-3 px-5 py-4">
        <input
          autoFocus
          value={editing.name}
          onChange={(e) => onName(e.target.value)}
          placeholder="Name the group (Desk, Living room…)"
          aria-label="Group name"
          className="min-w-[220px] flex-1 rounded-small bg-white/[0.04] px-4 py-1.5 text-[13px] text-high outline-none ring-1 ring-white/[0.08] placeholder:text-medium focus:ring-primary/50"
        />
        <button type="button" onClick={onSave} className="rounded-small bg-primary/[0.15] px-4 py-1.5 text-[13px] text-high ring-1 ring-primary/40 hover:bg-primary/[0.22]">
          Save group
        </button>
        <button type="button" onClick={onCancel} className="rounded-small px-3 py-1.5 text-[13px] text-medium hover:text-high">
          Cancel
        </button>
        {groups.some((g) => g.id === editing.id) && (
          <button type="button" onClick={onDelete} className="ml-auto inline-flex items-center gap-1.5 rounded-small px-3 py-1.5 text-[12.5px] text-medium hover:text-destructive">
            <Trash size={12} /> Delete group
          </button>
        )}
      </Card>
    );
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Groups">
      <SubHead>Groups</SubHead>
      <Chip on={value === ALL} onClick={() => onPick(ALL)}>
        All lights
      </Chip>
      {groups.map((g) => (
        <Chip key={g.id} on={value === g.id} onClick={() => onPick(g.id)}>
          {g.name}
        </Chip>
      ))}
      <button type="button" onClick={onNew} className="inline-flex items-center gap-1 rounded-small px-2.5 py-1 text-[12.5px] text-medium ring-1 ring-white/10 hover:bg-white/[0.06] hover:text-high">
        <Plus size={12} /> New group
      </button>
      {value !== ALL && (
        <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 rounded-small px-2.5 py-1 text-[12.5px] text-medium hover:text-high">
          <PencilSimple size={12} /> Edit
        </button>
      )}
    </div>
  );
}
