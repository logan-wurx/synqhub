// Arrow keys inside a radio group or a tab list, as with native radio buttons: Left / Up and Right / Down move to the
// previous or next option and pick it, Home and End to the first and last. Put it on the group's onKeyDown; Tab still
// moves in and out as usual.
import type { KeyboardEvent } from "react";

const STEP: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

export function arrowPick(e: KeyboardEvent<HTMLElement>) {
  const step = STEP[e.key];
  if (step === undefined && e.key !== "Home" && e.key !== "End") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"], [role="tab"]')).filter((el) => !(el as HTMLButtonElement).disabled);
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0 || !items.length) return;
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + step + items.length) % items.length;
  e.preventDefault();
  items[next].focus();
  items[next].click();
}
