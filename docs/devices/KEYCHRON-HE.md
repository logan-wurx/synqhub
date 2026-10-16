# Keychron / Lemokey Hall-effect extension of VIA

Built 2026-10-14. Code: `src/lib/kb/via/keychron/` (`protocol.ts` codec, `guard.ts` second guard tier, `capability.ts` the layer,
`catalog.generated.ts` the 35 boards, `devices.ts`, `sim.ts`); the VIA backend (`src/lib/kb/via/backend.ts`) loads the layer for
vendor ids `0x3434` (Keychron, Lemokey) and `0x362D`. Rust: `src-tauri/src/hid.rs` (`keychron_he_frame_allowed`); web guard
`src/lib/web/guard.ts`. Tests: `node --test scripts/keychron-he-codec.test.ts`, `node scripts/keychron-he-session.sim.mjs`,
`cargo test --lib keychron`, fixture `src/lib/kb/via/keychron/keychron-he-frames.txt` (6757 frames, 410 allowed; regenerate with
`node scripts/keychron-he-allowlist-fixture.ts`). Nothing was sent to a keyboard.

## Source

Keychron's published QMK firmware, github.com/Keychron/qmk_firmware, branch `2025q3`, commit
`c5d998442710b38650903937249144a0cd728ebe`, GPL-2.0-or-later (SYNQ is AGPL-3.0, which GPL-2.0-or-later code may be combined
with): `keyboards/keychron/common/keychron_raw_hid.c/.h` (command ids, feature bits), `analog_matrix/analog_matrix.c`
(`analog_matrix_rx`), `analog_matrix_type.h` (packed structs), `profile.c` and `analog_matrix_eeconfig.h`. The board catalogue is
generated from the firmware's own `keyboard.json` files: `node scripts/gen-keychron-he-catalog.mjs <tree> <commit>`.

## Transport

Same channel as VIA: usage page `0xFF60`, usage `0x61`, 32-byte reports, no report id. The Keychron commands share the first byte
with VIA's, `0xA0` and up (`data[0]` is the command, `data[1]` the sub-command). SYNQ adds no second channel: `ViaTransport`
takes an `extension` verdict that is consulted only when the VIA guard refuses a frame, and only for the 35 HE ids.

## Commands

| Frame | Meaning | SYNQ |
|---|---|---|
| `A0` | protocol version, reply `[A0, 02, 00, 02]` | read |
| `A1` | firmware version, text | read |
| `A2` | feature mask (bit `0x08` of the first byte: analog matrix) | read |
| `A7 01` | misc protocol version | read |
| `A9 01` | analog protocol version (SYNQ understands 4) | read |
| `A9 10` | profiles: current, count, size, OKMC count, SOCD count | read |
| `A9 12 i lo hi n` | raw profile bytes, n at most 26 | read |
| `A9 14 ...` | set travel: profile, mode, actuation, press and release sensitivity, then row masks or "entire" | write |
| `A9 1F i` | save profile `i` to EEPROM | write, always sent right after a set |
| `A7 11` factory reset, `A9 1E` profile reset, `A9 40` calibrate (and `41`, `42`) | | blocked |
| `AA` wireless DFU, `AB` factory and RF test | | blocked |
| `A9 11`, `13`, `15`, `16`, `21`, `23` (select profile, name, advanced keys, SOCD, curve, game-controller mode) | | blocked for now |

VIA's own `0x0B` (bootloader jump) and `0x0A` (EEPROM reset) stay refused by the VIA guard; the extension cannot override them.

## Profile layout

A profile (3 on shipped boards) is the packed `analog_matrix_profile_t`: a global configuration, one 4-byte configuration per
matrix key (`mode:2, act:6, sens:6, rls:6, adv:4` plus data), 20 OKMC advanced keys of 19 bytes, 20 SOCD pairs of 3 bytes, a
30-byte name and a 2-byte CRC. A key's `mode` is 0 (follow the profile's), 1 (regular) or 2 (rapid trigger); a value of 0 for
actuation or sensitivity also means "follow the profile". Units are 0.1 mm, at most 3.9 mm (firmware refuses `act_pt > 39`).
A key index is `row * columns + column` of the matrix the firmware scans (the catalogue has it for every variant).

## Boards (35)

Keychron K2, K4, K6, K8, K10 HE; Q0, Q1, Q2, Q3, Q4, Q5, Q6, Q12 HE; Lemokey L1, P1, P2, P3 HE; ANSI, ISO and JIS variants as
the firmware builds them, each with its USB ids and key positions. HE boards are not in VIA's keyboard list, so the layout comes
from this catalogue (source "driver" in the panel).

## Behaviour

* The layer reads the active profile, shows actuation and rapid-trigger press and release for the profile and for each key, and
  plans changes. Keys in an advanced mode (dynamic keystroke, game-controller axis, toggle) are shown and left alone.
* A write sets the RAM copy (`A9 14`) and then saves it (`A9 1F`); the session reads the profile back and compares.
* A profile whose release distance is 0 follows its press distance, so a press-only change to the profile pins the release at its
  old value; a key's release falls back to the profile's, so it needs no such care.
* Writes need "Allow changes", like the rest of the VIA page. A profile that does not read like Keychron's analog profile (a
  global mode, actuation or sensitivity out of range, or a key value out of range) is shown read-only with the reason.
* Live key depth stays with AnalogSense (`src/lib/kb/analogsense/`), which owns Keychron HE boards through `keychronModel`.
* Not offered yet: report rate, Snap Click, debounce (`A7`), advanced keys, SOCD, curves, game-controller mode, profile names
  and selection, and calibration.

## Check on the first real run

1. `A0` / `A1` / `A2`: protocol version, firmware, analog bit set.
2. `A9 01` returns 4, `A9 10` returns plausible counts, and the raw profile reads back in range (SYNQ does not check the profile CRC).
3. One key's actuation write: the reply byte 2 is 0, the read-back matches, and the value survives a power cycle.
4. Wired only: the 2.4 GHz and Bluetooth modes are untested.
