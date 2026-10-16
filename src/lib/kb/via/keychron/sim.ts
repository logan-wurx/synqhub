// A simulated Keychron / Lemokey Hall-effect keyboard, for the browser preview (src/lib/kb/mock.ts) and the tests
// (scripts/keychron-he-session.sim.mjs): a stand-in HIDDevice on QMK's raw-HID collection that answers the VIA basics
// the backend reads (protocol, layers, keymap, macros) and Keychron's commands the way keychron_raw_hid.c and
// analog_matrix.c do: 0xA0..0xA2, the 0xA9 profile commands over a packed profile struct, with the same checks
// `profile_set_traval` makes (profile in range, mode 0..2, actuation at most 3.9 mm, a global mode of 0 refused) and a
// SAVE that copies the RAM profile to a separate "EEPROM" copy. It records every frame it receives, and separately the
// commands SYNQ must never send. Nothing here touches hardware.
import type { KcModel } from "./catalog.generated.ts";
import { AKM, AMC, KC, KEY_CONFIG_BYTES, NAME_BYTES, OKMC_BYTES, SOCD_BYTES, CRC_BYTES, decodeKeyConfig, encodeKeyConfig, type KeyConfig } from "./protocol.ts";

export interface SimKeychronOptions {
  model: KcModel;
  productName?: string;
  /** Profiles the firmware has (3 on shipped boards). */
  profiles?: number;
  /** Analog protocol version the board reports (4 is the one SYNQ understands). */
  analogVersion?: number;
  /** Whether the board's feature mask has the analog-matrix bit. */
  analog?: boolean;
  /** A key (matrix index) in dynamic-keystroke mode, to check it survives. */
  advancedKey?: number;
  /** Reply delay, ms. */
  delayMs?: number;
}

const OKMC = 20;
const SOCD = 20;
/** Commands that must never reach the board from SYNQ: [first byte, second byte or -1]. */
const NEVER: [number, number][] = [
  [0x0b, -1], // VIA bootloader jump
  [0x0a, -1], // VIA EEPROM reset
  [0x13, -1],
  [0x03, -1],
  [0x02, 0x03], // the switch-matrix read
  [KC.wirelessDfu, -1],
  [KC.factoryTest, -1],
  [KC.misc, 0x11],
  [KC.analog, AMC.resetProfile],
  [KC.analog, AMC.calibrate],
  [KC.analog, AMC.selectProfile],
  [KC.analog, AMC.setAdvanceMode],
  [KC.analog, AMC.setSocd],
  [KC.analog, AMC.setProfileName],
  [KC.analog, AMC.setCurve],
  [KC.analog, AMC.setGameControllerMode],
];

export class SimKeychronHe {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HIDCollectionInfo[];
  readonly model: KcModel;
  opened = false;
  oninputreport: ((e: HIDInputReportEvent) => void) | null = null;
  readonly received: Uint8Array[] = [];
  readonly forbidden: Uint8Array[] = [];
  /** Accepted 0xA9 0x14 writes: [profile, mode, act, sens, rls, entire]. */
  readonly sets: number[][] = [];
  saves = 0;
  readonly profileCount: number;
  current = 0;
  /** RAM profiles and the EEPROM copy a SAVE writes. */
  readonly ram: Uint8Array[] = [];
  readonly eeprom: Uint8Array[] = [];
  readonly size: number;
  readonly #o: SimKeychronOptions;
  readonly #delay: number;
  readonly #listeners = new Set<(e: HIDInputReportEvent) => void>();

  constructor(o: SimKeychronOptions) {
    this.#o = o;
    this.model = o.model;
    this.vendorId = o.model.vendorId;
    this.productId = o.model.productId;
    this.productName = o.productName ?? `${o.model.brand} ${o.model.name}`;
    this.profileCount = o.profiles ?? 3;
    this.#delay = o.delayMs ?? 1;
    const keys = o.model.rows * o.model.cols;
    this.size = CRC_BYTES + KEY_CONFIG_BYTES * (keys + 1) + NAME_BYTES + OKMC_BYTES * OKMC + SOCD_BYTES * SOCD;
    for (let p = 0; p < this.profileCount; p++) {
      const b = new Uint8Array(this.size);
      b.set(encodeKeyConfig({ mode: AKM.regular, act: 20, sens: 4, rls: 0, adv: 0, advData: 0 }), 0);
      new TextEncoder().encodeInto(`Profile ${p + 1}`, b.subarray(this.#nameAt(), this.#nameAt() + NAME_BYTES));
      this.ram.push(b);
      this.eeprom.push(b.slice());
    }
    if (o.advancedKey !== undefined) this.ram[0].set(encodeKeyConfig({ mode: AKM.regular, act: 0, sens: 0, rls: 0, adv: 2, advData: 3 }), KEY_CONFIG_BYTES + KEY_CONFIG_BYTES * o.advancedKey);
    this.eeprom[0] = this.ram[0].slice();
    const io = [{ reportId: 0, items: [{ reportSize: 8, reportCount: 32 }] }];
    this.collections = [{ usagePage: 0xff60, usage: 0x61, type: 1, children: [], inputReports: io, outputReports: io, featureReports: [] } as unknown as HIDCollectionInfo];
  }

  #nameAt(): number {
    return KEY_CONFIG_BYTES + KEY_CONFIG_BYTES * this.model.rows * this.model.cols + OKMC_BYTES * OKMC + SOCD_BYTES * SOCD;
  }

  /** A key's configuration in a profile (RAM). */
  keyConfig(index: number, profile = this.current): KeyConfig {
    return decodeKeyConfig(this.ram[profile], KEY_CONFIG_BYTES + KEY_CONFIG_BYTES * index);
  }
  globalConfig(profile = this.current): KeyConfig {
    return decodeKeyConfig(this.ram[profile], 0);
  }
  setKeyConfig(index: number, c: KeyConfig, profile = this.current): void {
    this.ram[profile].set(encodeKeyConfig(c), KEY_CONFIG_BYTES + KEY_CONFIG_BYTES * index);
    this.eeprom[profile] = this.ram[profile].slice();
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async forget() {
    this.opened = false;
  }
  addEventListener(type: string, l: EventListenerOrEventListenerObject) {
    if (type === "inputreport") this.#listeners.add(l as unknown as (e: HIDInputReportEvent) => void);
  }
  removeEventListener(type: string, l: EventListenerOrEventListenerObject) {
    if (type === "inputreport") this.#listeners.delete(l as unknown as (e: HIDInputReportEvent) => void);
  }
  dispatchEvent() {
    return true;
  }
  async sendFeatureReport() {
    throw new Error("QMK raw HID has no feature reports");
  }
  async receiveFeatureReport(): Promise<DataView> {
    throw new Error("QMK raw HID has no feature reports");
  }

  async sendReport(reportId: number, data: BufferSource) {
    if (!this.opened) throw new Error("The device isn't open.");
    if (reportId !== 0) throw new Error("QMK raw HID has no report ids");
    const f = new Uint8Array(32);
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    f.set(bytes.subarray(0, 32));
    this.received.push(f.slice());
    if (NEVER.some(([a, b]) => f[0] === a && (b < 0 || f[1] === b))) this.forbidden.push(f.slice());
    const reply = this.#handle(f);
    setTimeout(() => this.#emit(reply), this.#delay);
  }

  #emit(reply: Uint8Array) {
    const event = Object.assign(new Event("inputreport"), { device: this, reportId: 0, data: new DataView(reply.buffer) }) as unknown as HIDInputReportEvent;
    this.oninputreport?.(event);
    for (const l of [...this.#listeners]) l(event);
  }

  #handle(f: Uint8Array): Uint8Array {
    const r = f.slice();
    const unhandled = () => {
      r[0] = 0xff;
      return r;
    };
    const o = this.#o;
    switch (f[0]) {
      // ---- VIA basics
      case 0x01:
        r[1] = 0;
        r[2] = 12;
        return r;
      case 0x02:
        if (f[1] === 0x02 || f[1] === 0x04) return r;
        return unhandled();
      case 0x04:
      case 0x0c:
      case 0x0d:
        return r;
      case 0x11:
        r[1] = 4;
        return r;
      case 0x12: {
        r.fill(0, 4);
        return r;
      }
      // ---- Keychron
      case KC.protocolVersion:
        r[1] = 2;
        r[2] = 0;
        r[3] = 2;
        return r;
      case KC.firmwareVersion:
        r.fill(0, 1);
        new TextEncoder().encodeInto("v1.2.3 2025 Sep 30", r.subarray(1, 30));
        return r;
      case KC.supportFeature:
        r[1] = 0;
        r[2] = 0x01 | (o.analog === false ? 0 : 0x08);
        r[3] = 0x03;
        return r;
      case KC.misc:
        return f[1] === 0x01 ? Object.assign(r, { 2: 0, 3: 2, 4: 0, 5: 0x7f }) : unhandled();
      case KC.analog:
        return this.#analog(f, r, unhandled);
      default:
        return unhandled();
    }
  }

  #analog(f: Uint8Array, r: Uint8Array, unhandled: () => Uint8Array): Uint8Array {
    if (this.#o.analog === false) return unhandled();
    switch (f[1]) {
      case AMC.getVersion:
        r[2] = this.#o.analogVersion ?? 4;
        return r;
      case AMC.getProfilesInfo:
        r[2] = this.current;
        r[3] = this.profileCount;
        r[4] = this.size & 0xff;
        r[5] = this.size >> 8;
        r[6] = OKMC;
        r[7] = SOCD;
        return r;
      case AMC.getProfileRaw: {
        const idx = f[2];
        const off = f[3] | (f[4] << 8);
        const n = f[5];
        if (idx >= this.profileCount || off + n > this.size * this.profileCount) return r;
        r.fill(0, 6);
        r.set(this.ram[idx].subarray(off, Math.min(off + n, this.size)), 6);
        return r;
      }
      case AMC.setTravel: {
        const [profile, mode, act, sens, rls, entire] = [f[2], f[3], f[4], f[5], f[6], f[7]];
        // profile_set_traval's own validity check.
        if (profile >= this.profileCount || mode > AKM.rapid || act > 39 || (entire === 1 && mode === AKM.global)) {
          r[2] = 1;
          return r;
        }
        const ram = this.ram[profile];
        if (entire === 1) {
          const g = decodeKeyConfig(ram, 0);
          ram.set(encodeKeyConfig({ ...g, mode: mode as KeyConfig["mode"], act, sens, rls }), 0);
        } else {
          for (let row = 0; row < this.model.rows; row++) {
            const mask = f[8 + row * 3] | (f[9 + row * 3] << 8) | (f[10 + row * 3] << 16);
            for (let col = 0; col < this.model.cols; col++) {
              if (!(mask & (1 << col))) continue;
              const at = KEY_CONFIG_BYTES + KEY_CONFIG_BYTES * (row * this.model.cols + col);
              const k = decodeKeyConfig(ram, at);
              ram.set(encodeKeyConfig({ ...k, mode: mode as KeyConfig["mode"], act, sens, rls }), at);
            }
          }
        }
        this.sets.push([profile, mode, act, sens, rls, entire]);
        r[2] = 0;
        return r;
      }
      case AMC.saveProfile:
        if (f[2] >= this.profileCount) {
          r[2] = 1;
          return r;
        }
        this.eeprom[f[2]] = this.ram[f[2]].slice();
        this.saves++;
        r[2] = 0;
        return r;
      default:
        return unhandled();
    }
  }
}
