// Whether the website can drive a device on this OS and browser. It is a small rule table, not a probe:
// nothing here talks to a device. The rules come from the WebHID platform research (docs/devices/BRANDS.md
// and the 2026-10-13 webhid-platform notes):
//
//   - Chromium 153 on Windows (Chrome, Edge, Opera) now strips input/output reports from Generic Desktop
//     mouse and keyboard collections, and a collection left with nothing is dropped, so a device whose
//     control channel sits on one of those (Razer) disappears or can't be sent to. The desktop app talks
//     to it natively instead.
//   - Royal Kludge's BeiYing keyboards (RK61 / 68 / 84 / 87 / 100, the M75 family...) are configured through the
//     System Control collection (usage page 0x0001, usage 0x0080). Chromium protects that collection for every
//     report type on every platform, so no web page can open it. The desktop bridge opens exactly that
//     collection, for feature reports only, and SYNQ Helper does the same for the website.
//   - requestDevice() consumes the user gesture on 153+, so the "Add device" button opens one chooser per
//     click (src/lib/web/hid.ts).
//   - A device is remembered across visits only when it has a serial number and a product name.
//
// The answer is shown after the person picks a device, as a friendly card with a link to the desktop app
// and a way to connect SYNQ Helper, which lifts the Razer rule.
import { RAZER, brandDevice } from "./policy.ts";
import { OS_NAMES, type Platform } from "./platform.ts";

export type AvailabilityStatus = "ok" | "desktop";

export interface Availability {
  status: AvailabilityStatus;
  /** A short code the tests and the UI can switch on. */
  code: "ok" | "razer-windows-153" | "rk-system-control";
  title: string;
  /** One or two sentences for the person. */
  message: string;
}

/** The Chromium version that changed how Windows treats mouse / keyboard collections. */
export const WINDOWS_PROTECTED_COLLECTIONS_FROM = 153;

export interface DeviceRef {
  vendorId: number;
  productId: number;
  name?: string;
}

const OK: Availability = { status: "ok", code: "ok", title: "Works in the browser", message: "" };

/**
 * `helper`: SYNQ Helper is connected (src/lib/web/helper.ts). It reaches the channel natively, with the
 * desktop app's guards, so the device works here after all.
 */
export function availability(device: DeviceRef, platform: Platform, helper = false): Availability {
  if (!helper && device.vendorId === RAZER && platform.os === "windows" && platform.chromium !== null && platform.chromium >= WINDOWS_PROTECTED_COLLECTIONS_FROM) {
    return {
      status: "desktop",
      code: "razer-windows-153",
      title: "Install the helper to use this in the browser",
      message: `Chrome, Edge and Opera ${WINDOWS_PROTECTED_COLLECTIONS_FROM} and newer on Windows hide the channel Razer devices are set up through. SYNQ Helper reaches it for this page: get it from Settings here (one small file for Windows, it installs itself). Or use the desktop app.`,
    };
  }
  if (!helper && brandDevice(device.vendorId, device.productId)?.guard === "rk-beiying") {
    return {
      status: "desktop",
      code: "rk-system-control",
      title: "Use the desktop app for this keyboard",
      message: "Royal Kludge's classic keyboards are set up through a System Control channel that Chrome, Edge and Opera never let a web page open. The desktop app (or SYNQ Helper, which comes with it) reaches it. Nothing is sent from this page.",
    };
  }
  return OK;
}

/** A sentence for a device that was picked but wouldn't open, from where the page runs. */
export function openFailureHint(platform: Platform): string {
  switch (platform.os) {
    case "linux":
      return "On Linux the browser needs permission to open the device (a udev rule). Replug it after adding one, or use the desktop app.";
    case "windows":
      return "Another program may be holding it. Close the maker's own app (Armoury Crate, Synapse, G HUB, iCUE) and try again.";
    case "mac":
      return "Another program may be holding it. Close the maker's own app and try again.";
    default:
      return `The browser couldn't open it on ${OS_NAMES[platform.os]}. Replug it and try again.`;
  }
}

/** Whether `requestDevice` takes `exclusionFilters` (Chromium 91 and newer). */
export const supportsExclusionFilters = (platform: Platform): boolean => platform.chromium === null || platform.chromium >= 91;
