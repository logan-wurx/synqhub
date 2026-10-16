// The website's own UI pieces, loaded only on the website. In the desktop build `__ONBOARD_WEB__` is
// defined false, so every import below is dead code: none of this (nor the guard, the policy tables or the
// browser store behind it) is in the desktop bundle. In the website build each piece is a small lazy chunk.
import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";

const WEB = typeof __ONBOARD_WEB__ !== "undefined" && __ONBOARD_WEB__ === true;

const Add = WEB ? lazy(() => import("./AddDevice").then((m) => ({ default: m.AddDeviceButton }))) : null;
const AddLamp = WEB ? lazy(() => import("./AddLight").then((m) => ({ default: m.AddLightButton }))) : null;
const Picked = WEB ? lazy(() => import("./WebNotes").then((m) => ({ default: m.WebPicked }))) : null;
const Notes = WEB ? lazy(() => import("./WebNotes").then((m) => ({ default: m.WebNoteCards }))) : null;
const Data = WEB ? lazy(() => import("./WebData").then((m) => ({ default: m.WebData }))) : null;
const Helper = WEB ? lazy(() => import("./HelperConnect").then((m) => ({ default: m.HelperConnect }))) : null;
const HelperPill = WEB ? lazy(() => import("./HelperConnect").then((m) => ({ default: m.WebHelperChip }))) : null;
const Sound = WEB ? lazy(() => import("./DesktopCard").then((m) => ({ default: m.WebSoundPage }))) : null;
const Desktop = WEB ? lazy(() => import("./DesktopCard").then((m) => ({ default: m.DesktopOnlyCard }))) : null;

type AddProps = { notify: (n: { title: string; detail?: string; tone: "ok" | "error" | "info"; action?: { label: string; run: () => void } }, key?: string) => void; className?: string; label?: string };
type DesktopProps = { title: string; text: string; className?: string };

export const AddDeviceButton = (p: AddProps) => (Add ? <Suspense fallback={null}><Add {...p} /></Suspense> : null);
/** Govee lamps through the browser's Bluetooth chooser (src/lib/lighting/web). */
export const AddLightButton = (p: AddProps) => (AddLamp ? <Suspense fallback={null}><AddLamp {...p} /></Suspense> : null);
export const WebPicked = () => (Picked ? <Suspense fallback={null}><Picked /></Suspense> : null);
export const WebNoteCards = () => (Notes ? <Suspense fallback={null}><Notes /></Suspense> : null);
export const WebData = () => (Data ? <Suspense fallback={null}><Data /></Suspense> : null);
export const HelperConnect = () => (Helper ? <Suspense fallback={null}><Helper /></Suspense> : null);
export const WebHelperChip = (p: { onOpen: () => void }) => (HelperPill ? <Suspense fallback={null}><HelperPill {...p} /></Suspense> : null);
export const WebSoundPage = (p: { notify: AddProps["notify"] }) => (Sound ? <Suspense fallback={null}><Sound {...p} /></Suspense> : null);
export const DesktopOnlyCard = (p: DesktopProps) => (Desktop ? <Suspense fallback={null}><Desktop {...p} /></Suspense> : null);

export type { AddProps, DesktopProps, ComponentProps };
