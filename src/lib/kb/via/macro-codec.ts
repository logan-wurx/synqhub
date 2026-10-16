// VIA / Vial macros: the bytes QMK keeps in its macro buffer, and SYNQ's small text form for them.
//
// The buffer is a run of macros, each ended by a 0x00. Inside one macro (QMK's dynamic keymap macros, VIA
// protocol 9 and later; quantum/dynamic_keymap.c, vial-qmk's vial.c):
//   0x20..0x7E          a character, typed as if sent with send_string (US layout)
//   0x01 0x01 <key>     tap a basic key (HID usage 0x04..0xE7)
//   0x01 0x02 <key>     hold a basic key down
//   0x01 0x03 <key>     let a basic key up
//   0x01 0x04 <digits>| wait that many milliseconds (ASCII digits, ended by '|')
// SYNQ writes exactly these and nothing else: no 16-bit key codes, so a macro can never tap a
// bootloader or EEPROM-clear key. Anything else already in the buffer (another firmware's extra action
// kinds) is shown as "can't be shown" and left alone, byte for byte.
//
// The text form: plain text types itself; {Enter} taps a key; {tap A}, {down Shift}, {up Shift} spell the
// three actions; {wait 100} waits; {lbrace} and {rbrace} type the braces. Pure.

const NAMES: Record<string, number> = {
  Enter: 0x28,
  Esc: 0x29,
  Bksp: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Caps: 0x39,
  PrtSc: 0x46,
  Ins: 0x49,
  Home: 0x4a,
  PgUp: 0x4b,
  Del: 0x4c,
  End: 0x4d,
  PgDn: 0x4e,
  Right: 0x4f,
  Left: 0x50,
  Down: 0x51,
  Up: 0x52,
  Ctrl: 0xe0,
  Shift: 0xe1,
  Alt: 0xe2,
  Win: 0xe3,
  RCtrl: 0xe4,
  RShift: 0xe5,
  RAlt: 0xe6,
  RWin: 0xe7,
};
for (let i = 0; i < 26; i++) NAMES[String.fromCharCode(65 + i)] = 0x04 + i;
for (let i = 0; i < 9; i++) NAMES[String(i + 1)] = 0x1e + i;
NAMES["0"] = 0x27;
for (let i = 0; i < 12; i++) NAMES[`F${i + 1}`] = 0x3a + i;

const BY_CODE = new Map(Object.entries(NAMES).map(([n, c]) => [c, n]));
const BY_LOWER = new Map(Object.entries(NAMES).map(([n, c]) => [n.toLowerCase(), c]));

/** The key names the text form knows, for the editor's quick-insert row. */
export const MACRO_KEY_NAMES: readonly string[] = Object.keys(NAMES);

export const SS_PREFIX = 0x01;
export const SS = { tap: 0x01, down: 0x02, up: 0x03, delay: 0x04 } as const;
const MAX_DELAY_MS = 99_999;

/** The text form of one macro (its bytes, without the 0x00 that ends it), or null when it holds something else. */
export function macroToText(bytes: readonly number[]): string | null {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === SS_PREFIX) {
      const kind = bytes[i + 1];
      if (kind === SS.delay) {
        let j = i + 2;
        let digits = "";
        while (j < bytes.length && bytes[j] >= 0x30 && bytes[j] <= 0x39) digits += String.fromCharCode(bytes[j++]);
        if (!digits || bytes[j] !== 0x7c || Number(digits) > MAX_DELAY_MS) return null;
        out += `{wait ${Number(digits)}}`;
        i = j;
      } else if (kind === SS.tap || kind === SS.down || kind === SS.up) {
        const name = BY_CODE.get(bytes[i + 2]);
        if (!name) return null;
        out += kind === SS.tap ? `{${name}}` : `{${kind === SS.down ? "down" : "up"} ${name}}`;
        i += 2;
      } else return null;
    } else if (b >= 0x20 && b <= 0x7e) {
      out += b === 0x7b ? "{lbrace}" : b === 0x7d ? "{rbrace}" : String.fromCharCode(b);
    } else return null;
  }
  return out;
}

export type Encoded = { ok: true; bytes: number[] } | { ok: false; error: string };

/** The bytes of one macro from its text form (without the closing 0x00). */
export function textToMacro(text: string): Encoded {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      const end = text.indexOf("}", i);
      if (end < 0) return { ok: false, error: "A { is never closed. Use {lbrace} to type a brace." };
      const body = text.slice(i + 1, end).trim();
      i = end;
      if (body === "lbrace") {
        bytes.push(0x7b);
        continue;
      }
      if (body === "rbrace") {
        bytes.push(0x7d);
        continue;
      }
      const wait = /^wait\s+(\d+)$/i.exec(body);
      if (wait) {
        const ms = Number(wait[1]);
        if (ms < 1 || ms > MAX_DELAY_MS) return { ok: false, error: `A wait takes 1 to ${MAX_DELAY_MS} milliseconds.` };
        bytes.push(SS_PREFIX, SS.delay, ...Array.from(String(ms), (c) => c.charCodeAt(0)), 0x7c);
        continue;
      }
      const act = /^(tap|down|up)\s+(.+)$/i.exec(body);
      const kind = act ? (act[1].toLowerCase() as "tap" | "down" | "up") : "tap";
      const name = act ? act[2].trim() : body;
      const code = BY_LOWER.get(name.toLowerCase());
      if (code === undefined) return { ok: false, error: `"${name}" isn't a key name SYNQ knows.` };
      bytes.push(SS_PREFIX, SS[kind], code);
    } else if (ch === "}") {
      return { ok: false, error: "A } has no { before it. Use {rbrace} to type a brace." };
    } else {
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) return { ok: false, error: `"${ch}" can't be typed by a macro; plain letters, digits and symbols only.` };
      bytes.push(code);
    }
  }
  return { ok: true, bytes };
}

/** The macros in a buffer: `count` byte runs, each ended by a 0x00 (missing ones are empty). */
export function splitMacros(buffer: readonly number[], count: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < buffer.length && out.length < count; i++) {
    if (buffer[i] === 0) {
      out.push(cur);
      cur = [];
    } else cur.push(buffer[i]);
  }
  while (out.length < count) out.push([]);
  return out;
}

/** The buffer for these macros, each ended by a 0x00, padded with zeros to `capacity`; null when they don't fit. */
export function joinMacros(macros: readonly (readonly number[])[], capacity: number): number[] | null {
  const bytes: number[] = [];
  for (const m of macros) bytes.push(...m, 0);
  if (bytes.length > capacity) return null;
  while (bytes.length < capacity) bytes.push(0);
  return bytes;
}
