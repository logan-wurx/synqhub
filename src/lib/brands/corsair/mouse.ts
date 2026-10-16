// CORSAIR Bragi mice (Web Hub generation): guarded read / write / read-back (local BrandMouseSession).
//
// Plain SETs, no mode switch (Web Hub sends these in mode 1): lift height 0x06, angle snap 0x07,
// debounce 0x0A + 0x38 (5 + n), motion sync 0x113. Polling (0x01) goes to address 0 (the receiver
// when wireless) inside operating mode 2, as Web Hub does. DPI:
//   - non-profile mice (Sabre v3 Pro family, Harpoon v2 wired): SET 0x18..0x1C, active stage SET 0x1E;
//   - profile mice (Scimitar Elite W SE, Nightsword V2, Harpoon V2 W): the stage values live in the
//     active profile's properties file (ids 24-28), patched and rewritten inside mode 2.
// Behind a SLIPSTREAM receiver the mouse is address log2(GET 0x36) (normally 1).
import { emptyMouseSettings, verdictOf, type BrandMouseSession, type HidLike, type MouseChange, type MouseFeatures, type MouseSettings, type MouseWriteResult } from "../types.ts";
import * as B from "./bragi.ts";
import { corsairModel, corsairMouseFeatures, type CorsairModel } from "./devices.ts";
import { CORSAIR_BLOCKED } from "./guard.ts";
import { BragiLink, type BragiLinkOptions } from "./link.ts";

const LIFT_LABEL: Record<number, string> = { 1: "Lowest", 2: "Low", 3: "Medium", 4: "High", 5: "Highest", 6: "Calibrated", 7: "Lower" };

export function claimsCorsairMouse(vendorId: number, productId: number): CorsairModel | null {
  if (vendorId !== B.CORSAIR_VID) return null;
  const m = corsairModel(productId);
  return m && (m.family === "mouse-bragi" || m.family === "receiver") ? m : null;
}

export class CorsairMouseSession implements BrandMouseSession {
  /** The HID device's model (a mouse, or the receiver it is plugged through). */
  readonly device: CorsairModel;
  /** The mouse's model (after open(); the same as `device` when wired). */
  mouse: CorsairModel;
  features: MouseFeatures;
  readonly blocked = CORSAIR_BLOCKED;
  readonly link: BragiLink;
  #last: MouseSettings = emptyMouseSettings();
  #opened = false;

  constructor(hid: HidLike, model: CorsairModel, o: BragiLinkOptions = {}) {
    if (model.family !== "mouse-bragi" && model.family !== "receiver") throw new Error(`${model.name} is not a Bragi mouse or receiver`);
    this.device = model;
    this.mouse = model;
    this.features = corsairMouseFeatures(model);
    this.link = new BragiLink(hid, model, o);
  }

  /** Finds the mouse behind a receiver (GET 0x36 bitmap, then GET 0x12 at that address). */
  async open(): Promise<void> {
    if (this.#opened) return;
    if (this.device.family === "receiver") {
      const bits = await this.link.getU32(B.PROP.subdevices, 0);
      let addr = 0;
      for (let i = 1; i <= 7; i++) if (bits & (1 << i)) {
        addr = i;
        break;
      }
      if (!addr) throw new Error("No mouse is connected to the receiver. Wake the mouse and try again.");
      this.link.addr = addr;
      const pid = await this.link.getU32(B.PROP.usbPid, addr);
      const m = corsairModel(pid & 0xffff);
      if (!m || m.family !== "mouse-bragi") throw new Error(`The receiver's device 0x${(pid & 0xffff).toString(16)} is not a mouse SYNQ knows.`);
      this.mouse = m;
      this.features = corsairMouseFeatures(m);
    }
    this.#opened = true;
  }

  get last(): MouseSettings {
    return this.#last;
  }

  async #profileProps(): Promise<{ file: number; props: B.PropertiesFile }> {
    return this.link.withHostControl(async () => {
      const list = B.decodeProfilesList(await this.link.readFile(B.FILE.profilesList));
      const idx = (await this.link.tryU32(B.PROP.activeProfile)) ?? 0;
      const profile = B.decodeProfileFile(await this.link.readFile(list[idx] ?? list[0]));
      return { file: profile.properties, props: B.decodePropertiesFile(await this.link.readFile(profile.properties)) };
    });
  }

  async read(): Promise<MouseSettings> {
    await this.open();
    const l = this.link;
    const s = emptyMouseSettings();
    s.firmware = B.decodeFirmware(await l.get(B.PROP.firmware));
    s.pollingHz = B.pollingHz((await l.tryU32(B.PROP.pollingRate, 0)) ?? 0);
    s.liftOff = await l.tryU32(B.PROP.liftHeight);
    s.liftOffLabel = s.liftOff === null ? null : (LIFT_LABEL[s.liftOff] ?? null);
    const snap = await l.tryU32(B.PROP.angleSnap);
    s.angleSnap = snap === null ? null : snap === 1;
    const deb = await l.tryU32(B.PROP.debounce);
    s.debounceMs = deb === null ? null : deb;
    const ms = await l.tryU32(B.PROP.motionSync);
    s.motionSync = ms === null ? null : ms === 1;
    const bat = await l.tryU32(B.PROP.batteryLevel);
    s.battery = bat === null ? null : { percent: Math.round(bat / 10), charging: null };
    if (this.mouse.table.supportsProfile) {
      const { props } = await this.#profileProps();
      s.dpi = [0, 1, 2, 3, 4].map((i) => B.propU32(props, B.PROP.dpiStage1 + i) ?? 0).filter((v) => v > 0);
      s.profile = ((await l.tryU32(B.PROP.activeProfile)) ?? 0) + 1;
    } else {
      const dpi: number[] = [];
      for (let i = 0; i < 5; i++) {
        const v = await l.tryU32(B.PROP.dpiStage1 + i);
        if (v) dpi.push(v);
      }
      s.dpi = dpi;
      s.activeStage = await l.tryU32(B.PROP.activeDpiStage);
    }
    this.#last = s;
    return s;
  }

  #dpi(dpi: number): number {
    const d = this.mouse.table.dpi;
    if (!d) throw new Error("This mouse has no DPI table.");
    if (!Number.isInteger(dpi) || dpi < d.min || dpi > d.max || (dpi - d.min) % d.step) throw new Error(`DPI must be ${d.min}..${d.max} in steps of ${d.step}.`);
    return dpi;
  }

  async apply(c: MouseChange): Promise<MouseWriteResult> {
    await this.open();
    const l = this.link;
    let expected: unknown;
    switch (c.kind) {
      case "polling": {
        if (!this.mouse.table.pollingWiredHz.includes(c.hz) && !this.mouse.table.pollingWirelessHz.includes(c.hz)) throw new Error(`${c.hz} Hz isn't offered on the ${this.mouse.name}.`);
        await l.withHostControl(() => l.set(B.PROP.pollingRate, B.pollingCode(c.hz), 0), 0);
        expected = c.hz;
        break;
      }
      case "liftOff":
        if (!Number.isInteger(c.value) || c.value < 1 || c.value > 5) throw new Error("Lift height is 1 (lowest) .. 5 (highest).");
        await l.set(B.PROP.liftHeight, c.value);
        expected = c.value;
        break;
      case "angleSnap":
        await l.set(B.PROP.angleSnap, c.on ? 1 : 0);
        expected = c.on;
        break;
      case "motionSync":
        await l.set(B.PROP.motionSync, c.on ? 1 : 0);
        expected = c.on;
        break;
      case "debounce": {
        if (!Number.isInteger(c.ms) || c.ms < 5 || c.ms > 14) throw new Error("Debounce is 5..14 (Web Hub's 0..9 + 5).");
        await l.set(B.PROP.debounce, c.ms);
        await l.set(B.PROP.debounce2, c.ms);
        expected = c.ms;
        break;
      }
      case "dpi": {
        if (!Number.isInteger(c.stage) || c.stage < 0 || c.stage > 4) throw new Error("Stages are 0..4.");
        const v = this.#dpi(c.dpi);
        if (this.mouse.table.supportsProfile) {
          const { file, props } = await this.#profileProps();
          await l.withHostControl(() => l.writeFile(file, B.encodePropertiesFile(B.withPropU32(props, B.PROP.dpiStage1 + c.stage, v))));
        } else await l.withHostControl(() => l.set(B.PROP.dpiStage1 + c.stage, v));
        expected = v;
        break;
      }
      case "activeStage":
        if (this.mouse.table.supportsProfile) throw new Error("On this mouse the active stage is per profile; switch it on the mouse.");
        if (!Number.isInteger(c.stage) || c.stage < 0 || c.stage > 4) throw new Error("Stages are 0..4.");
        await l.withHostControl(() => l.set(B.PROP.activeDpiStage, c.stage));
        expected = c.stage;
        break;
      case "profile":
        if (!this.mouse.table.supportsProfile) throw new Error("This mouse has no onboard profiles.");
        await l.set(B.PROP.activeProfile, c.index - 1);
        expected = c.index;
        break;
    }
    const s = await this.read();
    const got =
      c.kind === "polling" ? s.pollingHz : c.kind === "liftOff" ? s.liftOff : c.kind === "angleSnap" ? s.angleSnap : c.kind === "motionSync" ? s.motionSync : c.kind === "debounce" ? s.debounceMs : c.kind === "dpi" ? s.dpi?.[c.stage] : c.kind === "activeStage" ? s.activeStage : s.profile;
    return { verdict: verdictOf(expected, got ?? undefined), expected, got, persistence: "saved" };
  }

  close(): Promise<void> {
    return this.link.close();
  }
}
