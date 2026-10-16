# SparkLink keyboards (Royal Kludge, AULA, Kochi)

Built 2026-10-14. Code: `src/lib/brands/sparklink/` (`protocol.ts` codec, `devices.ts` ids, `guard.ts` allowlist, `session.ts`,
`kb-driver.ts`, `sim.ts`); Rust guard `src-tauri/src/brands.rs` (`sparklink`); web guard `src/lib/web/guard.ts`.
Tests: `node --test scripts/sparklink-codec.test.ts`, `node scripts/sparklink-session.sim.mjs`, `cargo test --lib sparklink`,
and the frame fixture `src/lib/brands/sparklink/sparklink-frames.txt` (9004 frames, 302 allowed; regenerate with
`node scripts/sparklink-allowlist-fixture.ts`). No keyboard was ever attached: every byte below is read from documentation or
source, never from a device.

## Sources and licences

| What | Licence | Used for |
|---|---|---|
| `@sparklinkplayjoy/sdk-keyboard` 1.0.24 and `@sparklinkplayjoy/protocol-keyboard` 1.0.7 (npm) | `package.json` says MIT; no LICENSE file, no per-file headers | framing, order and layout numbers, reply layouts (read in a scratch folder, never run) |
| `sparklinkplayjoy/keyboard-docs` | no licence file | the same facts, as documentation |
| AureTrix-Solutions/AureTrix_driver | MIT | how key mode, actuation, rapid trigger and dead zones are written (per key, by default key value); that the global message's dead zones are unreliable |
| `@openmouse/keyboard-protocol` 1.1.0 | AGPL-3.0-or-later | the Kochi Hummingbird 68 mode switch, exercised there on hardware |
| drive.rkgaming.com, magnet.aulastar.com | public web drivers | USB ids only (read as data) |

SYNQ writes its own driver from these; nothing is copied. The SDK's v2 (`sdk-keyboard-v2`, usage page `0xFFB0`, another
framing) is not used.

## Transport

Usage page `0xFFA0`, usage `0x0001`, 64-byte reports, report id 0. One output report per request, one input report per reply.

```
request  [0x5C, len, cmd, checksum, data...]        data = len bytes (1..60), the rest zero
reply    [0x5C, len, cmd | 0x80, checksum, data...] (cmd 0xFF: the board refused)
checksum = (0x35 + 0x5C + len + cmd + data[len - 1]) & 0xFF
```

The board can stream; replies are matched by command class and the echoed order type, key and layout, and anything else is skipped.

| cmd class | meaning | data |
|---|---|---|
| 0 | order | `[type, args..., 0xFF, 0xFF]` (reads send the filler) |
| 1 | sync (board info: version, serial) | |
| 35 | key layouts | `[flag 0 read / 1 write, then 4-byte groups key, layout, value lo, value hi]` |
| 41 | global travel | travel and dead zones |
| 43 | default key table | rows 0 to 5 |

A key is addressed by its default key value (the HID usage of the factory layout, 1 = Fn). Layouts SYNQ touches: 4 actuation
(`db0`), 8 mode (touch mode in the high nibble, advanced-key mode in the low), 20 and 21 rapid-trigger press and release, 22 and 23
top and bottom dead zone. Layout 25 (the switch type) is never written. Travel values are micrometres (at most 4000).

## What SYNQ sends

Reads: protocol version (order 0x01), Windows-key lock (0x20), Windows and Mac queries (0x21, 0x22), travel range (0x25), name
(0x26), report rate (0x50), configuration (0x70), current axis and axis list (0x75, 0x76), the sync, the default key table, and
reads of the layouts above. Writes: those layouts, one layout of one key at a time with values in range (a mode write names no
advanced-key mode), the global travel write, and the Windows / Mac switch (orders 0x30, 0x31).

Never sent: the bootloader (classes 8 to 14, which the SDK uses to update firmware over this same channel), screen pictures (48,
49), factory restore (order 0x11), calibration (0x04, 0x0C, 0x0D), macro storage and data (0x10, classes 32, 33), the key map and
Fn layers, advanced keys (classes 36 to 40, 44, 45), lighting, and any order or class not listed. The session narrows the static
verdict further: to the keys the board reported, and to reads only until the person switches "Allow changes" on.

## Ids (56, all "experimental")

* Royal Kludge: 21 on `1CA2`, `1604` to `161B` (the M75 HE is `1619`).
* AULA: `1C4F:EE88`, 17 on `1CA5`, 11 on `1CA2:1901` to `190B`, 5 on `1CA3`.
* Kochi Hummingbird 68: `1CA2:0901`. omkb used to claim it and now yields, so exactly one driver owns each id.

Neither web driver lists update-mode ids: the SDK reboots the same board into a boot application whose sync reply starts with
"Boot". SYNQ refuses a board that answers that way.

Which boards have Hall-effect keys is in neither list. SYNQ asks the board (the travel-range order) and shows the analog
section only when it answers.

## Behaviour

* Per-key and global actuation, rapid-trigger press and release and top and bottom dead zones. A key given its own values
  switches to its own mode. Keys in an advanced mode are shown and skipped.
* The panel reads dead zones from the keys while in global mode, because the global message's dead zones are unreliable.
* Windows or Mac mode: the one setting a third party has exercised on a Kochi; its group is marked "driver-tested" only when the
  board's name is "KOCHI68". Every other board's settings are "experimental".
* Polling rate and profiles are read-only. There is no explicit save command in the SDK: persistence across a power cycle is
  unknown, so every write is read back and the verdict says what the board reports.
* Feel: actuation and rapid trigger feed "Keep your feel" through the generic keyboard view.

## Check on the first real run

1. The sync reply: app version (10 characters), serial, name; an "RK M75HE" or "KOCHI68" style name.
2. The travel-range order answers (that decides whether the board is Hall-effect).
3. A read of every key's layouts matches the default key table.
4. One key's actuation write, then the read-back. Then a power cycle to see whether it persisted.
5. Windows / Mac switch on the Kochi.
