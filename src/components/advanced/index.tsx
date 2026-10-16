// The Advanced card is loaded on demand: its code is fetched when a device panel that shows it is on screen
// (docs/performance.md: nothing is downloaded for a device that isn't there). The panels import from here.
import { lazy, Suspense, type ComponentProps } from "react";
import { isWeb } from "@/lib/runtime";
import { DesktopOnlyCard } from "@/components/web/lazy";
import { useHelperReady } from "@/lib/web/use-helper";

const Card = lazy(() => import("./AdvancedCard").then((m) => ({ default: m.AdvancedCard })));
const Info = lazy(() => import("./AdvancedCard").then((m) => ({ default: m.InfoAdvanced })));

/**
 * The Advanced actions (pairing, button / key changes, macros, switch calibration, factory reset) each need
 * a short-lived grant that the desktop bridge issues and checks. On the website that bridge is SYNQ
 * Helper (src/lib/web/helper.ts): with it connected the card works exactly as in the app, with the same
 * Rust guards. Without it the browser's guard (src/lib/web/guard.ts) refuses every frame that needs a
 * grant, so there is nothing to unlock; the card says where to go instead.
 */
export function AdvancedCard(props: ComponentProps<typeof Card>) {
  const helper = useHelperReady();
  if (isWeb && !helper) {
    return (
      <DesktopOnlyCard
        title="Install the helper to use this in the browser"
        text="Pairing, button and key changes, macros, switch calibration and factory reset need the desktop app's extra safety checks: use SYNQ Helper (it comes with the desktop app) or the app itself. Everything else on this page works here."
      />
    );
  }
  return (
    <Suspense fallback={null}>
      <Card {...props} />
    </Suspense>
  );
}

export function InfoAdvanced(props: ComponentProps<typeof Info>) {
  return (
    <Suspense fallback={null}>
      <Info {...props} />
    </Suspense>
  );
}
