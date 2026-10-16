// A VIA or Vial keyboard as a KbBackend: reads the protocol, the layout (Vial: from the keyboard;
// VIA: the definition from usevia.app, cached), the dynamic keymap for every layer, the QMK
// lighting channels and the macro buffer, and plans two kinds of change: a basic keycode on one key,
// and a lighting value (set, then saved to EEPROM). Macros are read-only. Every frame goes through
// the guard (guard.ts) in ViaTransport, so the blocked commands can't be sent from here at all.
// No Tauri, no React.
import { AdvancedGate, nativeOf } from "../../advanced/core.ts";
import type { AdvancedPanel } from "../../advanced/types.ts";
import type { BlockedCommand, DefinitionSource, KbBackend, KbChange, KbContext, KbLayout, KbPlan, KbState, KbSupport, LightingSetting, LightingValue } from "../types.ts";
import { viaAdvanced } from "./advanced.ts";
import { MAX_WRITABLE_KEYCODE, VIA_BLOCKED } from "./guard.ts";
import type { KeychronHe } from "./keychron/capability.ts";
import type { KcModel } from "./keychron/catalog.generated.ts";
import { KEYCHRON_BLOCKED, keychronGuardFor, type KeychronContext } from "./keychron/guard.ts";
import { ASSIGNABLE, keycodeLabel, type KeycodeScheme } from "./keycodes.ts";
import { layoutFor, parseCompiled, parseVial, unpackOptions, type ParsedDefinition } from "./layout.ts";
import { lightingChannels, lightingSettingId, type LightingChannelDef, type LightingValueDef } from "./lighting.ts";
import { ViaClient, type LightingScheme } from "./protocol.ts";
import { hidChannel, ViaTransport, type RawChannel } from "./transport.ts";

const ASSIGNABLE_CODES = new Set(ASSIGNABLE.map((a) => a.code));
/** Macro buffers larger than this are summarised by size only. */
const MACRO_READ_LIMIT = 4096;

interface Raw {
  protocol: number;
  vial: { protocol: number; uid: string } | null;
  layoutOptions: number | null;
  firmware: number | null;
  layers: number;
  keymap: number[][] | null;
  lighting: Record<string, number[] | null>;
  macroCount: number;
  macroBytes: number;
  macroBuffer: number[] | null;
  definition: { name: string; origin: string; rows: number; cols: number } | null;
}

export class ViaBackend implements KbBackend {
  readonly #t: ViaTransport;
  readonly #c: ViaClient;
  readonly #device: { vendorId: number; productId: number; productName: string };
  readonly #definitions?: DefinitionSource;
  readonly #store?: KbContext["store"];
  /** The keyboard's Advanced tokens; the transport's guard reads it. */
  readonly #gate: AdvancedGate;
  #advanced?: AdvancedPanel;
  #def: ParsedDefinition | null = null;
  #layout: KbLayout | null = null;
  #channels: LightingChannelDef[] = [];
  #scheme: LightingScheme = "channel";
  #keys: KeycodeScheme = "current";
  #raw: Raw | null = null;
  #state: KbState;
  /** Keychron's Hall-effect layer, for the ids keychron/devices.ts lists. */
  readonly #kc: { layer: KeychronHe; model: KcModel; definition: () => ParsedDefinition } | null;

  private constructor(
    t: ViaTransport,
    device: { vendorId: number; productId: number; productName: string },
    gate: AdvancedGate,
    definitions?: DefinitionSource,
    store?: KbContext["store"],
    kc: { layer: KeychronHe; model: KcModel; definition: () => ParsedDefinition } | null = null,
  ) {
    this.#kc = kc;
    this.#t = t;
    this.#c = new ViaClient(t);
    this.#device = device;
    this.#definitions = definitions;
    this.#store = store;
    this.#gate = gate;
    this.#state = { info: { brand: "VIA", model: device.productName || "Keyboard", driver: "via", firmware: [], connection: "USB" }, notes: [] };
  }

  /** Opens the raw-HID channel and reads everything. Nothing that changes the keyboard is sent. */
  static async open(device: HIDDevice, ctx: Partial<Pick<KbContext, "definitions" | "store">>, channel: RawChannel = hidChannel(device), trace?: (line: string) => void): Promise<ViaBackend> {
    const gate = new AdvancedGate(`via:${device.vendorId.toString(16)}:${device.productId.toString(16)}`, nativeOf(device));
    // Keychron / Lemokey Hall-effect boards: a second guard tier and the analog layer (loaded only for those vendors).
    let kc: { layer: KeychronHe; model: KcModel; definition: () => ParsedDefinition } | null = null;
    let extension: ((frame: Uint8Array) => ReturnType<ReturnType<typeof keychronGuardFor>>) | undefined;
    let holder: ViaTransport | null = null;
    if (device.vendorId === 0x3434 || device.vendorId === 0x362d) {
      const { keychronModel, keychronDefinition } = await import("./keychron/devices.ts");
      const model = keychronModel(device.vendorId, device.productId);
      if (model) {
        const { KeychronHe } = await import("./keychron/capability.ts");
        const kctx: KeychronContext = { profile: null, rows: model.rows, cols: model.cols, writes: false };
        extension = keychronGuardFor(() => kctx);
        kc = { layer: new KeychronHe(model, (f) => holder!.request(f, "echo"), kctx), model, definition: () => keychronDefinition(model) };
      }
    }
    const t = new ViaTransport(channel, { trace, grants: gate, extension });
    holder = t;
    await t.open();
    const b = new ViaBackend(t, device, gate, ctx.definitions, ctx.store, kc);
    try {
      await b.load();
    } catch (e) {
      await t.close().catch(() => undefined);
      throw e;
    }
    return b;
  }

  get driver(): string {
    return this.#raw?.vial ? "vial" : "via";
  }

  get state(): KbState {
    return this.#state;
  }

  get support(): KbSupport {
    const r = this.#raw;
    const proto = r ? (r.vial ? `Vial ${r.vial.protocol} · VIA protocol ${r.protocol}` : `VIA protocol ${r.protocol}`) : "VIA";
    if (this.#kc) return { tier: "read-only", why: `${proto}, plus Keychron's analog commands as published in its firmware. SYNQ hasn't been tried on this board.` };
    return { tier: "read-only", why: `${proto}. A standard protocol, but SYNQ hasn't been tried on this board.` };
  }

  get blocked(): readonly BlockedCommand[] {
    return this.#kc ? [...VIA_BLOCKED, ...KEYCHRON_BLOCKED] : VIA_BLOCKED;
  }

  snapshot(): unknown {
    return this.#kc ? { ...this.#raw, keychron: this.#kc.layer.snapshot() } : this.#raw;
  }

  async close(): Promise<void> {
    await this.#gate.revokeAll().catch(() => undefined);
    return this.#t.close();
  }

  /** The Advanced card's actions: keys beyond the basic ones, macros, a keymap + macro reset (advanced.ts). */
  advanced(): AdvancedPanel {
    return (this.#advanced ??= viaAdvanced({
      client: this.#c,
      gate: this.#gate,
      store: this.#store,
      deviceName: this.#state.info.model,
      brand: this.#raw?.vial ? "Vial" : "VIA",
      vendorId: this.#device.vendorId,
      productId: this.#device.productId,
      scheme: this.#keys,
      protocolLine: this.#state.info.protocol ?? "VIA",
      firmware: this.#state.info.firmware,
      matrix: () => (this.#def && this.#layout && this.#raw?.keymap ? { rows: this.#def.rows, cols: this.#def.cols, keys: this.#layout.keys.map((k) => k.index) } : null),
      layers: () => this.#raw?.layers ?? 0,
      macros: () => ({ count: this.#raw?.macroCount ?? 0, bytes: this.#raw?.macroBytes ?? 0 }),
      reload: async () => void (await this.load()),
    }));
  }

  async load(): Promise<KbState> {
    const c = this.#c;
    const protocol = await c.protocolVersion();
    if (protocol === null) throw new Error("This keyboard's raw-HID channel doesn't answer VIA's protocol query.");
    const vial = await c.vialId().catch(() => null);
    const notes: string[] = [];
    // The layout: Vial from the keyboard, VIA from the definition source.
    let def: ParsedDefinition | null = null;
    let origin = "";
    if (vial) {
      try {
        def = parseVial(await c.vialDefinition());
        origin = "Layout from the keyboard (Vial)";
      } catch (e) {
        notes.push(`The keyboard's Vial layout couldn't be read (${String(e).replace(/^Error: /, "")}), so its keys can't be drawn.`);
      }
    } else if (this.#definitions) {
      for (const version of protocol >= 11 ? (["v3", "v2"] as const) : (["v2", "v3"] as const)) {
        const got = await this.#definitions.get(version, this.#device.vendorId, this.#device.productId).catch(() => null);
        if (!got) continue;
        try {
          def = parseCompiled(got.json);
          const kept = this.#definitions.kept ?? "this PC";
          origin = got.origin === "cache" ? `Layout from VIA's keyboard list, kept on ${kept}` : `Layout fetched from VIA's keyboard list (usevia.app) and kept on ${kept}`;
          break;
        } catch {
          /* try the other version */
        }
      }
    }
    if (this.#kc) {
      // Keychron's Hall-effect boards are not in VIA's keyboard list: their layout is the firmware's own definition.
      const own = this.#kc.definition();
      if (!def || def.rows !== own.rows || def.cols !== own.cols) {
        if (def) notes.push(`VIA's layout for this keyboard (${def.rows} x ${def.cols}) doesn't match the firmware's matrix (${own.rows} x ${own.cols}); the firmware's is used.`);
        def = own;
        origin = "Layout from Keychron's published firmware (keyboard.json)";
      }
    } else if (!def && this.#definitions && !vial) {
      const problem = this.#definitions.problem?.();
      notes.push(`${problem ?? "VIA has no layout for this keyboard, or it couldn't be fetched"}, so its keys and lighting can't be shown. Its VIA protocol and firmware still are.`);
    }
    const layoutOptions = await c.layoutOptions().catch(() => null);
    const firmware = await c.firmwareVersion().catch(() => null);
    const layers = await c.layerCount().catch(() => 0);
    this.#keys = vial ? (vial.protocol >= 6 ? "current" : "legacy") : protocol >= 12 ? "current" : "legacy";
    this.#scheme = vial || protocol < 11 ? "legacy" : "channel";

    let keymap: number[][] | null = null;
    this.#layout = null;
    if (def && def.rows > 0 && def.cols > 0 && layers > 0) {
      keymap = await c.readKeymap(layers, def.rows, def.cols);
      this.#layout = layoutFor(def, unpackOptions(def.labels, layoutOptions ?? 0), vial ? "vial-firmware" : origin.startsWith("Layout from Keychron") ? "driver" : "via-definition", origin);
    }
    this.#def = def;

    this.#channels = def ? lightingChannels(def.menus, def.lighting, this.#scheme) : [];
    const lighting: Record<string, number[] | null> = {};
    for (const ch of this.#channels) for (const v of ch.values) lighting[lightingSettingId(ch, v)] = await c.getLighting(ch.scheme, ch.channel, v.valueId, v.bytes).catch(() => null);
    if (vial && def?.lighting === "vialrgb") notes.push("This board uses VialRGB lighting, which SYNQ doesn't drive yet.");

    const macroCount = await c.macroCount().catch(() => 0);
    const macroBytes = macroCount ? await c.macroBufferSize().catch(() => 0) : 0;
    const macroBuffer = macroBytes && macroBytes <= MACRO_READ_LIMIT ? Array.from(await c.readMacroBuffer(macroBytes).catch(() => new Uint8Array())) : null;

    this.#raw = {
      protocol,
      vial,
      layoutOptions,
      firmware,
      layers,
      keymap,
      lighting,
      macroCount,
      macroBytes,
      macroBuffer,
      definition: def ? { name: def.name, origin, rows: def.rows, cols: def.cols } : null,
    };
    if (this.#kc) {
      try {
        await this.#kc.layer.read();
        notes.push(...this.#kc.layer.state.notes);
        if (!this.#kc.layer.state.plausible && !this.#kc.layer.state.notes.length && this.#kc.layer.state.why) notes.push(`Keychron's analog settings aren't shown: ${this.#kc.layer.state.why}`);
      } catch (e) {
        notes.push(`Keychron's analog settings couldn't be read (${String(e).replace(/^Error: /, "")}).`);
      }
    }
    this.#state = this.#build(notes);
    return this.#state;
  }

  #build(notes: readonly string[]): KbState {
    const r = this.#raw!;
    const def = this.#def;
    const layout = this.#layout;
    const kc = this.#kc;
    const name = kc ? (kc.model.variant ? `${kc.model.name} (${kc.model.variant})` : kc.model.name) : def?.name || this.#device.productName || "Keyboard";
    const protocol = r.vial ? `Vial ${r.vial.protocol} · VIA ${r.protocol}` : `VIA protocol ${r.protocol}`;
    const kcFirmware = kc?.layer.state.firmware;
    const state: KbState = {
      info: {
        brand: kc ? kc.model.brand : r.vial ? "Vial" : "VIA",
        model: name,
        driver: r.vial ? "vial" : "via",
        protocol: kc ? `${protocol} · Keychron analog v${kc.layer.state.analogVersion ?? "?"}` : protocol,
        firmware: [...(r.firmware ? [`Firmware ${r.firmware}`] : []), ...(kcFirmware ? [`Keychron firmware ${kcFirmware}`] : [])],
        serial: r.vial?.uid ?? null,
        connection: "USB",
        extra: [
          ["Protocol", protocol],
          ...(def ? ([["Matrix", `${def.rows} × ${def.cols}`]] as [string, string][]) : []),
          ["Layers", String(r.layers)],
        ],
      },
      notes: [...notes],
    };
    if (kc && layout) {
      const analog = kc.layer.analog(layout);
      if (analog) state.analog = analog;
    }
    if (layout && r.keymap) {
      const keys = layout.keys.map((k) => k.index);
      state.keymap = {
        layout,
        layers: r.layers,
        codes: r.keymap.map((layer) => Object.fromEntries(keys.map((i) => [i, layer[i] ?? 0]))),
        keySpace: "qmk",
        label: (code) => keycodeLabel(code, this.#keys),
        assignable: ASSIGNABLE,
        writable: true,
        source: "device",
        note: `Key labels follow QMK's ${this.#keys === "current" ? "current" : "pre-0.19"} keycodes. SYNQ writes basic keys only; layer, macro and system keys are shown, not written.`,
      };
    }
    if (this.#channels.length) {
      state.lighting = {
        groups: this.#channels.map((ch) => ({ id: ch.id, label: ch.label, settings: ch.values.map((v) => this.#setting(ch, v)) })),
        source: "device",
        note: "Saved to the keyboard after each change. Effect names follow VIA's list; a firmware built with fewer effects numbers them differently.",
      };
    }
    if (r.macroCount) {
      state.macros = { count: r.macroCount, bufferBytes: r.macroBytes || null, summaries: summarizeMacros(r.macroBuffer, r.macroCount), note: "Macros are shown, never written, for now." };
    }
    return state;
  }

  #setting(ch: LightingChannelDef, v: LightingValueDef): LightingSetting {
    const raw = this.#raw!.lighting[lightingSettingId(ch, v)];
    const value: LightingValue | null = !raw ? null : v.kind === "color" ? [raw[0] ?? 0, raw[1] ?? 0] : v.kind === "toggle" ? (raw[0] ? 1 : 0) : (raw[0] ?? 0);
    return { id: lightingSettingId(ch, v), label: v.label, kind: v.kind, spec: v.spec, choice: v.choice, value, writable: raw !== null };
  }

  plan(change: KbChange): KbPlan {
    if (change.kind === "analog") {
      if (!this.#kc) throw new Error("This keyboard has no analog settings.");
      return this.#wrapKeychron(this.#kc.layer.plan(change));
    }
    if (change.kind === "keycode") return this.#planKeycode(change.layer, change.key, change.code);
    if (change.kind === "lighting") return this.#planLighting(change.id, change.value);
    throw new Error("VIA keyboards don't have that setting.");
  }

  /** A Keychron plan, with the panel's state rebuilt from what the layer holds after each step. */
  #wrapKeychron(p: KbPlan): KbPlan {
    return {
      label: p.label,
      get expected() {
        return p.expected;
      },
      persistence: p.persistence,
      send: async () => {
        await p.send();
        this.#state = this.#build(this.#state.notes);
      },
      readBack: async () => {
        const got = await p.readBack();
        this.#state = this.#build(this.#state.notes);
        return got;
      },
    };
  }

  #planKeycode(layer: number, key: number, code: number): KbPlan {
    const def = this.#def;
    const r = this.#raw;
    if (!def || !this.#layout || !r?.keymap) throw new Error("Keys can't be changed without this keyboard's layout.");
    if (!Number.isInteger(layer) || layer < 0 || layer >= r.layers) throw new Error(`This keyboard has layers 0 to ${r.layers - 1}.`);
    if (!this.#layout.keys.some((k) => k.index === key)) throw new Error("That key isn't on this keyboard's layout.");
    if (!Number.isInteger(code) || code < 0 || code > MAX_WRITABLE_KEYCODE || !ASSIGNABLE_CODES.has(code)) throw new Error("SYNQ only puts basic keys on a key (letters, numbers, F-keys, navigation, modifiers, media).");
    const row = Math.floor(key / def.cols);
    const col = key % def.cols;
    return {
      label: `Layer ${layer}: ${keycodeLabel(r.keymap[layer][key] ?? 0, this.#keys) || "none"} → ${keycodeLabel(code, this.#keys) || "none"}`,
      expected: code,
      persistence: "saved",
      send: () => this.#c.setKeycode(layer, row, col, code),
      readBack: async () => {
        const got = await this.#c.getKeycode(layer, row, col);
        r.keymap![layer][key] = got;
        this.#state = this.#build(this.#state.notes);
        return got;
      },
    };
  }

  #planLighting(id: string, value: LightingValue): KbPlan {
    const ch = this.#channels.find((c) => c.values.some((v) => lightingSettingId(c, v) === id));
    const v = ch?.values.find((x) => lightingSettingId(ch, x) === id);
    if (!ch || !v) throw new Error("This keyboard has no such lighting setting.");
    let data: number[];
    if (v.kind === "color") {
      if (!Array.isArray(value) || value.length !== 2 || value.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error("A colour is a hue and a saturation, 0 to 255 each.");
      data = [value[0], value[1]];
    } else {
      const n = value as number;
      const max = v.kind === "toggle" ? 1 : v.kind === "choice" ? (v.choice?.options.length ?? 1) - 1 : (v.spec?.max ?? 255);
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) throw new Error(`${v.label} takes 0 to ${max}.`);
      data = [n];
    }
    const expected = v.kind === "color" ? data : data[0];
    return {
      label: `${ch.label}: ${v.label}`,
      expected,
      persistence: "saved",
      send: async () => {
        await this.#c.setLighting(ch.scheme, ch.channel, v.valueId, data);
        await this.#c.saveLighting(ch.scheme, ch.channel);
      },
      readBack: async () => {
        const got = await this.#c.getLighting(ch.scheme, ch.channel, v.valueId, v.bytes);
        if (!got) return undefined;
        this.#raw!.lighting[id] = got;
        this.#state = this.#build(this.#state.notes);
        return v.kind === "color" ? got.slice(0, 2) : v.kind === "toggle" ? (got[0] ? 1 : 0) : got[0];
      },
    };
  }
}

/** One short line per macro: its printable text, or how many actions it has. */
export function summarizeMacros(buffer: readonly number[] | null, count: number): string[] {
  if (!buffer) return Array.from({ length: count }, (_, i) => `Macro ${i}`);
  const out: string[] = [];
  let cur: number[] = [];
  for (let i = 0; i < buffer.length && out.length < count; i++) {
    if (buffer[i] === 0) {
      out.push(describe(cur));
      cur = [];
    } else cur.push(buffer[i]);
  }
  while (out.length < count) out.push("Empty");
  return out;
}

function describe(bytes: number[]): string {
  if (!bytes.length) return "Empty";
  let text = "";
  let actions = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x01) {
      // An action: tap / down / up (+ keycode), or a delay (+ digits until '|').
      actions++;
      const kind = bytes[i + 1];
      if (kind === 0x04) {
        const end = bytes.indexOf(0x7c, i);
        i = end < 0 ? bytes.length : end;
      } else i += 2;
    } else if (bytes[i] >= 0x20 && bytes[i] < 0x7f) text += String.fromCharCode(bytes[i]);
  }
  const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return shown ? `"${shown}"${actions ? ` + ${actions} key actions` : ""}` : `${actions} key actions`;
}
