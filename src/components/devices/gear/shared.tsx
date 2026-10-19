// What the Gear page's layouts share (./Bento.tsx, ./Shelves.tsx, ./Spotlight.tsx): the devices sorted into their
// kinds, and the active device's orange tick.
import { useMemo } from "react";
import { Check } from "@phosphor-icons/react";
import { groupOf } from "@/lib/device-groups";
import type { DeviceEntry } from "@/lib/device-model";

export interface KindGroup {
  id: string;
  label: string;
  items: DeviceEntry[];
}

/** The entries by kind, in the order they come (byGroup already put them in group order). */
export function useGroups(entries: readonly DeviceEntry[]): KindGroup[] {
  return useMemo(() => {
    const out: KindGroup[] = [];
    for (const e of entries) {
      const g = groupOf(e.kind);
      const at = out.find((x) => x.id === g.id);
      if (at) at.items.push(e);
      else out.push({ id: g.id, label: g.label, items: [e] });
    }
    return out;
  }, [entries]);
}

export interface LayoutProps {
  entries: readonly DeviceEntry[];
  activeId: string | null;
  /** The pointer or focus is on a device: get its page's code ready. */
  onIntent?: (kind: DeviceEntry["kind"]) => void;
}

/** The active device's mark: the orange corner with a tick, sized to the corner it sits in (its radius one less). */
export function ActiveTick({ radius, size }: { radius: number; size: number }) {
  return (
    <span aria-hidden="true" className="absolute right-0 top-0 grid place-items-center bg-primary" style={{ width: size, height: size, borderTopRightRadius: radius - 1, borderBottomLeftRadius: radius }}>
      <Check size={Math.round(size * 0.42)} weight="bold" className="-translate-y-px translate-x-px text-primary-foreground" />
    </span>
  );
}
