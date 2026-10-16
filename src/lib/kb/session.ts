// The only way the generic Keyboard panel changes a keyboard. It wraps a driver's KbBackend and adds
// the rules every driver gets the same way:
//   - tiers: read-only groups stay locked until the person turns on "Allow changes";
//   - before the first change it saves a backup of everything it read (KbStore);
//   - after every change it reads the keyboard back and compares: confirmed, mismatch, or
//     unconfirmed when the keyboard can't report the value;
//   - every change and its read-back go to the keyboard's log;
//   - changes run one at a time.
// No Tauri, no React: the website version can use it as it is, with its own KbStore.
import { infoOnlyPanel, lockedPanel } from "../advanced/panel.ts";
import type { AdvancedPanel } from "../advanced/types.ts";
import { splitVersion } from "../advanced/firmware.ts";
import {
  PERSISTENCE_LABEL,
  groupOf,
  isAdvancedChange,
  type ChangeGroup,
  type KbAnyChange,
  type KbBackend,
  type KbStore,
  type KbTier,
  type KbView,
  type KbWriteResult,
  type Verdict,
} from "./types.ts";

export const GROUPS: readonly ChangeGroup[] = ["analog", "keymap", "lighting", "polling", "profiles", "options", "advanced"];

/** Numbers compared to 3 decimals (mm fields), colours as lower-case, arrays element-wise. */
const norm = (v: unknown): unknown =>
  typeof v === "number" ? Math.round(v * 1000) / 1000 : typeof v === "string" ? v.toLowerCase() : Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const show = (v: unknown) => (v === null || v === undefined ? "nothing" : typeof v === "string" ? v : JSON.stringify(v));
const hex = (n: number) => n.toString(16).padStart(4, "0");
/** File-name-safe slug. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "keyboard";

export class KbSession {
  readonly #backend: KbBackend;
  readonly #store: KbStore;
  readonly #device: { vendorId: number; productId: number; productName: string };
  #allow = false;
  #advanced?: AdvancedPanel;
  #backup: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(backend: KbBackend, store: KbStore, device: { vendorId: number; productId: number; productName: string }) {
    this.#backend = backend;
    this.#store = store;
    this.#device = device;
  }

  get id(): string {
    return `${hex(this.#device.vendorId)}:${hex(this.#device.productId)}`;
  }

  get backend(): KbBackend {
    return this.#backend;
  }

  get view(): KbView {
    const s = this.#backend.state;
    const support = this.#backend.support;
    const groupTier = Object.fromEntries(GROUPS.map((g) => [g, support.groups?.[g] ?? support.tier])) as Record<ChangeGroup, KbTier>;
    const readOnly = GROUPS.filter((g) => groupTier[g] === "read-only");
    const writable = Object.fromEntries(GROUPS.map((g) => [g, groupTier[g] !== "read-only" || this.#allow])) as Record<ChangeGroup, boolean>;
    return {
      ...s,
      id: this.id,
      name: s.info.model || this.#device.productName || "Keyboard",
      brand: s.info.brand,
      driver: s.info.driver,
      tier: support.tier,
      tierWhy: support.why,
      groupTier,
      writable,
      lockedReason: readOnly.length && !this.#allow ? "Read-only until you allow changes." : null,
      canAllow: readOnly.length > 0,
      allowChanges: this.#allow,
      blocked: this.#backend.blocked,
      backupPath: this.#backup,
    };
  }

  /**
   * The Advanced card's actions for this keyboard. They stay shut while any of its groups is still read-only
   * and "Allow changes" is off; the card additionally asks for its own confirmation per action.
   */
  get advanced(): AdvancedPanel {
    return (this.#advanced ??= lockedPanel(
      this.#backend.advanced?.() ??
        infoOnlyPanel({
          deviceName: this.view.name,
          kind: "keyboard",
          brand: this.#backend.state.info.brand,
          versions: this.#backend.state.info.firmware.map(splitVersion),
          why: `SYNQ has no documented Advanced commands for ${this.#backend.state.info.brand} keyboards.`,
        }),
      () => this.view.lockedReason,
    ));
  }

  /** The read-only tier's switch. */
  setAllowChanges(on: boolean): KbView {
    this.#allow = on;
    return this.view;
  }

  /** Reads the keyboard again. */
  refresh(): Promise<KbView> {
    return this.#serial(async () => {
      await this.#backend.load();
      return this.view;
    });
  }

  close(): Promise<void> {
    return this.#backend.close();
  }

  /** Where the first backup went, once there is one. */
  get backupPath(): string | null {
    return this.#backup;
  }

  /** Changes one setting: backup first (once), send, read back, compare, log. */
  apply(change: KbAnyChange): Promise<KbWriteResult> {
    return this.#serial(() => this.#apply(change));
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #prefix(): string {
    return `kb-${slug(this.#backend.state.info.brand)}-${slug(this.view.name)}`;
  }

  async #apply(change: KbAnyChange): Promise<KbWriteResult> {
    const view = this.view;
    const group = groupOf(change);
    if (!view.writable[group]) throw new Error(view.lockedReason ?? "That can't be changed on this keyboard.");
    // The driver says no (unknown key, out of range, a blocked command) before anything is sent.
    let plan;
    if (isAdvancedChange(change)) {
      if (!this.#backend.planAdvanced) throw new Error("This keyboard's driver has no advanced keys.");
      plan = this.#backend.planAdvanced(change);
    } else plan = this.#backend.plan(change);
    await this.#backupOnce();
    const head = `# ${view.brand} ${view.name} ${this.id} ${view.driver}`;
    const log: string[] = [`${new Date().toISOString()} ${plan.label}: ${show(change)}`];
    try {
      await plan.send();
    } catch (e) {
      log.push(`  send failed: ${String(e)}`);
      await this.#store.log(this.#prefix(), [head, ...log]).catch(() => undefined);
      throw e;
    }
    let got: unknown;
    try {
      got = await plan.readBack();
    } catch (e) {
      log.push(`  read-back failed: ${String(e)}`);
      got = undefined;
    }
    const verdict: Verdict = got === undefined ? "unconfirmed" : sameValue(got, plan.expected) ? "confirmed" : "mismatch";
    log.push(`  read back: ${show(got)} expected ${show(plan.expected)} -> ${verdict} (${plan.persistence})`);
    await this.#store.log(this.#prefix(), [head, ...log]).catch(() => undefined);
    const checked =
      verdict === "confirmed" ? "Read back from the keyboard" : verdict === "unconfirmed" ? "Unconfirmed: the keyboard can't report this back" : `The keyboard reports ${show(got)} instead of ${show(plan.expected)}`;
    return { view: this.view, verdict, persistence: plan.persistence, detail: `${checked} · ${PERSISTENCE_LABEL[plan.persistence]}` };
  }

  async #backupOnce(): Promise<void> {
    if (this.#backup) return;
    const json = JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        note: "Everything SYNQ read from this keyboard before its first change (generic Keyboard panel).",
        device: { vendorId: hex(this.#device.vendorId), productId: hex(this.#device.productId), productName: this.#device.productName },
        driver: this.#backend.driver,
        state: this.#backend.state,
        raw: this.#backend.snapshot(),
      },
      (_k, x) => (x instanceof Uint8Array ? Array.from(x) : x instanceof Map ? Object.fromEntries(x) : typeof x === "bigint" ? String(x) : x),
      1,
    );
    this.#backup = await this.#store.saveBackup(this.#prefix(), json);
  }
}

/** In-memory store, for the browser preview and the tests. */
export function memoryKbStore(): KbStore & { backups: { prefix: string; json: string }[]; lines: string[] } {
  const backups: { prefix: string; json: string }[] = [];
  const lines: string[] = [];
  return {
    backups,
    lines,
    async saveBackup(prefix, json) {
      backups.push({ prefix, json });
      return `(memory) ${prefix}-${backups.length}.json`;
    },
    async log(_prefix, more) {
      lines.push(...more);
    },
  };
}
