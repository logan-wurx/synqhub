// How the Gear page lays out the devices: a card per kind (bento, the default), a shelf per kind on one glass pane, or
// one device on a stage with the rest in a rail. Picked with the switch in the page's header and remembered in the
// app's own storage (like the welcome's flag, src/lib/welcome.ts).
import { setKept, useKeptState } from "./keep";

export type GearLayout = "bento" | "shelves" | "spotlight";

const KEY = "synq.gearLayout";

function stored(): GearLayout {
  try {
    const v = localStorage.getItem(KEY);
    return v === "shelves" || v === "spotlight" ? v : "bento";
  } catch {
    return "bento";
  }
}

export function useGearLayout(): [GearLayout, (next: GearLayout) => void] {
  const [layout] = useKeptState<GearLayout>("gear.layout", stored);
  return [layout, setGearLayout];
}

export function setGearLayout(next: GearLayout): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* nothing to remember it in: it lasts for this run */
  }
  setKept<GearLayout>("gear.layout", next);
}
