// Every frame SYNQ sends a VIA or Vial keyboard passes here first (and again in the desktop
// bridge, src-tauri/src/hid.rs `via_frame_allowed`, which mirrors this; the fixture
// src-tauri/src/via-frames.txt, written by scripts/via-guard-fixture.ts, keeps the two in step).
//
// Allowed: protocol / firmware / layout-option reads, keymap reads and single basic-keycode writes,
// the three QMK lighting channels (and their legacy ids) and their save, macro reads, and Vial's
// definition reads. Everything else is refused, in particular:
//   - bootloader jump (0x0B), EEPROM reset (0x0A), dynamic keymap reset (0x06), bulk keymap write (0x13);
//   - macro writes and macro reset (0x0F, 0x10): macros are read-only for now;
//   - the switch-matrix read (0x02 0x03), which reports which keys are held, i.e. what you type;
//   - setting keyboard values (0x03), encoder writes (0x15);
//   - keycodes outside the basic range (QK_BOOT, QK_CLEAR_EEPROM, QK_REBOOT, layer keys...);
//   - every Vial command except its reads: no unlock start/poll, lock, QMK-settings set or reset,
//     dynamic-entry (tap dance / combo / key override) ops.
//
// Advanced (src/lib/advanced/core.ts): while the panel's AdvancedGate holds a live token, and only then,
//   - "remap": keycodes above the basic range, from advancedKeycodeOk's list only (layer keys, mod-tap,
//     macros...), never QK_BOOT, QK_REBOOT, QK_CLEAR_EEPROM or any custom / user code;
//   - "macros": macro buffer writes (0x0F) of at most one chunk, inside the first 4 KiB;
//   - "reset": dynamic keymap reset (0x06) and macro reset (0x10).
// The bootloader jump (0x0B), EEPROM reset (0x0A), bulk keymap write (0x13), setting keyboard values,
// encoder writes and every Vial write stay refused whatever is granted.
// Pure: no device access, no Tauri.
import { granted, grantedScheme, type AdvancedScope, type Grants } from "../../advanced/core.ts";
import { advancedKeycodeOk } from "./keycode-safety.ts";

export type Verdict = { ok: true; what: string; write: boolean; advanced?: AdvancedScope } | { ok: false; why: string };

/** Largest macro write: one frame's worth of data after the 4-byte header (32-byte frames). */
export const MACRO_CHUNK = 28;
/** Macro memory SYNQ will read or write: the first 4 KiB. */
export const MACRO_LIMIT = 4096;

export const VIA = {
  getProtocolVersion: 0x01,
  getKeyboardValue: 0x02,
  setKeyboardValue: 0x03,
  getKeycode: 0x04,
  setKeycode: 0x05,
  keymapReset: 0x06,
  customSetValue: 0x07,
  customGetValue: 0x08,
  customSave: 0x09,
  eepromReset: 0x0a,
  bootloaderJump: 0x0b,
  macroGetCount: 0x0c,
  macroGetBufferSize: 0x0d,
  macroGetBuffer: 0x0e,
  macroSetBuffer: 0x0f,
  macroReset: 0x10,
  getLayerCount: 0x11,
  keymapGetBuffer: 0x12,
  keymapSetBuffer: 0x13,
  getEncoder: 0x14,
  setEncoder: 0x15,
  vialPrefix: 0xfe,
  unhandled: 0xff,
} as const;

/** get_keyboard_value ids. */
export const VIA_VALUE = { uptime: 0x01, layoutOptions: 0x02, switchMatrixState: 0x03, firmwareVersion: 0x04, deviceIndication: 0x05 } as const;

/** Vial sub-commands (after 0xFE). */
export const VIAL = {
  getKeyboardId: 0x00,
  getSize: 0x01,
  getDefinition: 0x02,
  getEncoder: 0x03,
  setEncoder: 0x04,
  getUnlockStatus: 0x05,
  unlockStart: 0x06,
  unlockPoll: 0x07,
  lock: 0x08,
  qmkSettingsQuery: 0x09,
  qmkSettingsGet: 0x0a,
  qmkSettingsSet: 0x0b,
  qmkSettingsReset: 0x0c,
  dynamicEntryOp: 0x0d,
} as const;

/** The largest keycode SYNQ ever writes: QMK's basic range (KC_NO, KC_TRNS, letters... KC_RGUI). */
export const MAX_WRITABLE_KEYCODE = 0x00ff;

/** QMK lighting channels VIA v3 addresses (custom-value channel ids), and their value ids. */
export const CHANNEL = { backlight: 1, rgblight: 2, rgbMatrix: 3 } as const;
/** Legacy (VIA protocol 9/10 and Vial) lighting value ids. */
export const LEGACY_LIGHTING_IDS: readonly number[] = [0x09, 0x0a, 0x80, 0x81, 0x82, 0x83];

const block = (why: string): Verdict => ({ ok: false, why: `Blocked: ${why}.` });
const read = (what: string): Verdict => ({ ok: true, what, write: false });
const write = (what: string): Verdict => ({ ok: true, what, write: true });
const advanced = (what: string, scope: AdvancedScope): Verdict => ({ ok: true, what, write: true, advanced: scope });

/** The macro write the "macros" scope allows: [0x0F, offset hi, offset lo, size, data...], zero padded. */
function macroWriteShape(f: Uint8Array): string | null {
  const offset = (f[1] << 8) | f[2];
  const size = f[3];
  if (size < 1 || size > MACRO_CHUNK || size > f.length - 4) return `a macro write takes 1 to ${MACRO_CHUNK} bytes`;
  if (offset + size > MACRO_LIMIT) return `macro writes stay inside the first ${MACRO_LIMIT} bytes`;
  for (let i = 4 + size; i < f.length; i++) if (f[i] !== 0) return "bytes after the macro data must be zero";
  return null;
}

/**
 * `grants` is the device's AdvancedGate (src/lib/advanced/core.ts); without one every extra command
 * stays refused, exactly as before the Advanced section existed.
 */
export function checkViaFrame(f: Uint8Array, grants?: Grants): Verdict {
  if (f.length !== 32 && f.length !== 64) return { ok: false, why: `QMK raw-HID frames are 32 bytes (got ${f.length}).` };
  switch (f[0]) {
    case VIA.getProtocolVersion:
      return read("get protocol version");
    case VIA.getKeyboardValue:
      if (f[1] === VIA_VALUE.layoutOptions) return read("get layout options");
      if (f[1] === VIA_VALUE.firmwareVersion) return read("get firmware version");
      if (f[1] === VIA_VALUE.switchMatrixState) return block("the switch-matrix read (it reports which keys are held)");
      return { ok: false, why: `Blocked: keyboard value 0x${hex2(f[1])} isn't one SYNQ reads.` };
    case VIA.setKeyboardValue:
      return block("setting keyboard values");
    case VIA.getKeycode:
      return read("get keycode");
    case VIA.setKeycode: {
      const code = (f[4] << 8) | f[5];
      if (code <= MAX_WRITABLE_KEYCODE) return write("set keycode");
      if (granted(grants, "remap")) {
        const scheme = grantedScheme(grants);
        return scheme && advancedKeycodeOk(code, scheme)
          ? advanced("set keycode (advanced)", "remap")
          : { ok: false, why: `Blocked: keycode 0x${code.toString(16).padStart(4, "0")} isn't one SYNQ puts on a key (bootloader, reboot, EEPROM-clear and custom codes are never written).` };
      }
      return { ok: false, why: `Blocked: keycode 0x${code.toString(16).padStart(4, "0")} (SYNQ only writes basic keycodes).` };
    }
    case VIA.keymapReset:
      return granted(grants, "reset") ? advanced("dynamic keymap reset (advanced)", "reset") : block("dynamic keymap reset");
    case VIA.customSetValue: {
      const channel = f[1] >= 1 && f[1] <= 3 && f[2] >= 1 && f[2] <= 4;
      return channel || LEGACY_LIGHTING_IDS.includes(f[1]) ? write("set lighting value") : block("a custom value outside the QMK lighting channels");
    }
    case VIA.customGetValue:
      return read("get custom value");
    case VIA.customSave:
      return f[1] <= 3 ? write("save lighting") : block("saving a custom channel");
    case VIA.eepromReset:
      return block("EEPROM reset");
    case VIA.bootloaderJump:
      return block("bootloader jump");
    case VIA.macroGetCount:
      return read("get macro count");
    case VIA.macroGetBufferSize:
      return read("get macro buffer size");
    case VIA.macroGetBuffer:
      return read("get macro buffer");
    case VIA.macroSetBuffer: {
      if (!granted(grants, "macros")) return block("macro writes");
      const bad = macroWriteShape(f);
      return bad ? block(bad) : advanced("set macro buffer (advanced)", "macros");
    }
    case VIA.macroReset:
      return granted(grants, "reset") ? advanced("macro reset (advanced)", "reset") : block("macro reset");
    case VIA.getLayerCount:
      return read("get layer count");
    case VIA.keymapGetBuffer:
      return read("get keymap buffer");
    case VIA.keymapSetBuffer:
      return block("bulk keymap write");
    case VIA.getEncoder:
      return read("get encoder");
    case VIA.setEncoder:
      return block("encoder writes");
    case VIA.vialPrefix:
      switch (f[1]) {
        case VIAL.getKeyboardId:
          return read("vial keyboard id");
        case VIAL.getSize:
          return read("vial definition size");
        case VIAL.getDefinition:
          return read("vial definition page");
        case VIAL.getUnlockStatus:
          return read("vial unlock status");
        default:
          return { ok: false, why: `Blocked: Vial command 0x${hex2(f[1])} (only Vial's reads are sent).` };
      }
    default:
      return { ok: false, why: `Blocked: QMK raw-HID command 0x${hex2(f[0])} isn't on SYNQ's list.` };
  }
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** What SYNQ never sends a VIA / Vial keyboard, for the panel's "never sends" list. */
export const VIA_BLOCKED: readonly { what: string; why: "bootloader" | "factory-reset" | "keystrokes" | "macro" | "unverified" }[] = [
  { what: "Bootloader jump (0x0B)", why: "bootloader" },
  { what: "EEPROM reset (0x0A)", why: "factory-reset" },
  { what: "Bulk keymap write (0x13), and the dynamic keymap reset (0x06) outside Advanced", why: "factory-reset" },
  { what: "Bootloader, reboot and EEPROM-clear keycodes, and keycodes above the basic range outside Advanced", why: "bootloader" },
  { what: "Switch-matrix read (0x02 0x03): it reports which keys are held", why: "keystrokes" },
  { what: "Macro writes and macro reset (0x0F, 0x10) outside Advanced", why: "macro" },
  { what: "Setting keyboard values (0x03) and encoder writes (0x15)", why: "unverified" },
  { what: "Vial unlock, lock, QMK-settings write or reset, tap dance / combo / key-override writes", why: "unverified" },
];
