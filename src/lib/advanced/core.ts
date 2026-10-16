// Advanced actions: the confirmation step, the capability token and the per-device gate.
//
// SYNQ's guards refuse pairing, button / macro rewrites, switch calibration and factory resets by
// default. The Advanced section of a panel can unlock exactly those, one action at a time, and only
// through here:
//
//   1. the person confirms (a tick for every action; a reset also needs the word RESET typed);
//   2. `AdvancedGate.grant()` checks that confirmation, asks the desktop bridge for the matching grant
//      (src-tauri/src/advanced.rs) and returns an `AdvancedToken`;
//   3. the device's guard (VIA's, ATK's, the generic mouse wrapper's...) accepts the extra frames or
//      methods of that scope while the gate holds a live token for it, and the bridge checks again.
//
// A token can only be made here (its constructor refuses everything else), it belongs to one device and
// one scope, it expires on its own, and there is no scope for firmware, bootloader or DFU. Guards that
// are handed anything but a real AdvancedGate treat it as "nothing granted". Pure: no React, no Tauri.

export type AdvancedScope = "pair" | "remap" | "macros" | "calibrate" | "reset";

export const ADVANCED_SCOPES: readonly AdvancedScope[] = ["pair", "remap", "macros", "calibrate", "reset"];

/** The word a factory reset needs typed. Compared exactly (src-tauri/src/advanced.rs RESET_WORD). */
export const RESET_WORD = "RESET";

/** How long a token lasts if nobody revokes it; the same numbers as src-tauri/src/advanced.rs `Scope::ttl`. */
export const SCOPE_TTL_MS: Readonly<Record<AdvancedScope, number>> = {
  pair: 3 * 60_000,
  reset: 5 * 60_000,
  calibrate: 10 * 60_000,
  remap: 15 * 60_000,
  macros: 15 * 60_000,
};

/** Which keycode encoding a QMK / VIA board uses (the same code means different things in each). */
export type KeycodeScheme = "current" | "legacy";

/** What the person did in the confirmation step. */
export interface AdvancedConfirmation {
  /** They ticked "I understand". */
  acknowledged: boolean;
  /** What they typed (a reset needs exactly RESET). */
  typed?: string;
}

/** Why this confirmation isn't enough, or null when it is. */
export function confirmationProblem(scope: AdvancedScope, c: AdvancedConfirmation | undefined): string | null {
  if (!c || c.acknowledged !== true) return "Advanced actions need your confirmation first.";
  if (scope === "reset" && c.typed !== RESET_WORD) return `A factory reset needs the word ${RESET_WORD} typed to confirm.`;
  return null;
}

const MINT = Symbol("onboard.advanced.token");

/** Proof that one scope was confirmed for one device. Only `AdvancedGate.grant()` makes one. */
export class AdvancedToken {
  readonly scope: AdvancedScope;
  readonly deviceKey: string;
  readonly scheme: KeycodeScheme | undefined;
  readonly expiresAt: number;
  #revoked = false;

  constructor(mint: symbol, scope: AdvancedScope, deviceKey: string, expiresAt: number, scheme?: KeycodeScheme) {
    if (mint !== MINT) throw new Error("An advanced token can only come from a confirmed AdvancedGate.grant().");
    this.scope = scope;
    this.deviceKey = deviceKey;
    this.expiresAt = expiresAt;
    this.scheme = scheme;
  }

  allows(scope: AdvancedScope, deviceKey: string, now: number): boolean {
    return !this.#revoked && this.scope === scope && this.deviceKey === deviceKey && now < this.expiresAt;
  }

  revoke(): void {
    this.#revoked = true;
  }
}

/** What a guard reads. Only an AdvancedGate satisfies it; see `granted`. */
export interface Grants {
  has(scope: AdvancedScope): boolean;
  readonly scheme: KeycodeScheme | undefined;
}

/** The default path: nothing granted. */
export const NO_GRANTS: Grants = Object.freeze({ has: () => false, scheme: undefined });

/** The desktop bridge's side of a grant (the HID shim in src/lib/tauri-hid.ts); absent in the browser preview. */
export interface NativeGrant {
  advancedGrant?(scope: AdvancedScope, ack: AdvancedConfirmation, scheme?: KeycodeScheme): Promise<number>;
  advancedRevoke?(scope: AdvancedScope): Promise<void>;
}

/** Anything the bridge can be asked to grant on: an opened HID device from the shim, or nothing. */
export function nativeOf(device: unknown): NativeGrant | undefined {
  const d = device as NativeGrant | null | undefined;
  return d && typeof d.advancedGrant === "function" ? d : undefined;
}

/**
 * The tokens of one device. Every driver that has Advanced commands owns one gate and hands it to its
 * guard; the panel's confirmation step calls `grant`.
 */
export class AdvancedGate implements Grants {
  readonly deviceKey: string;
  readonly #native: NativeGrant | undefined;
  readonly #now: () => number;
  readonly #tokens = new Map<AdvancedScope, AdvancedToken>();

  constructor(deviceKey: string, native?: NativeGrant, now: () => number = Date.now) {
    this.deviceKey = deviceKey;
    this.#native = native;
    this.#now = now;
  }

  /**
   * Checks the confirmation, then (on the desktop) asks the bridge for the same grant, then returns the
   * token. Throws, granting nothing, when the confirmation is missing or the bridge refuses.
   */
  async grant(scope: AdvancedScope, confirmation: AdvancedConfirmation, opts: { scheme?: KeycodeScheme } = {}): Promise<AdvancedToken> {
    if (!ADVANCED_SCOPES.includes(scope)) throw new Error(`There is no advanced action called ${String(scope)}.`);
    const problem = confirmationProblem(scope, confirmation);
    if (problem) throw new Error(problem);
    if (this.#native) {
      if (!this.#native.advancedGrant) throw new Error("The desktop bridge can't grant advanced actions here.");
      await this.#native.advancedGrant(scope, { acknowledged: true, typed: confirmation.typed }, opts.scheme);
    }
    const token = new AdvancedToken(MINT, scope, this.deviceKey, this.#now() + SCOPE_TTL_MS[scope], opts.scheme);
    this.#tokens.get(scope)?.revoke();
    this.#tokens.set(scope, token);
    return token;
  }

  /** Ends the grant for `scope` (here and in the bridge). */
  async revoke(scope: AdvancedScope): Promise<void> {
    this.#tokens.get(scope)?.revoke();
    this.#tokens.delete(scope);
    await this.#native?.advancedRevoke?.(scope).catch(() => undefined);
  }

  async revokeAll(): Promise<void> {
    for (const scope of [...this.#tokens.keys()]) await this.revoke(scope);
  }

  has(scope: AdvancedScope): boolean {
    const t = this.#tokens.get(scope);
    return !!t && t.allows(scope, this.deviceKey, this.#now());
  }

  /** The keycode scheme the live remap token was granted for. */
  get scheme(): KeycodeScheme | undefined {
    return this.has("remap") ? this.#tokens.get("remap")?.scheme : undefined;
  }

  /** Scopes that are live right now. */
  get live(): readonly AdvancedScope[] {
    return ADVANCED_SCOPES.filter((s) => this.has(s));
  }
}

/** Whether `g` is a real gate holding a live token for `scope`. Anything else (a stub, a lookalike) is "no". */
export function granted(g: Grants | undefined, scope: AdvancedScope): boolean {
  return g instanceof AdvancedGate && g.has(scope);
}

/** The keycode scheme of a real gate's live remap token. */
export function grantedScheme(g: Grants | undefined): KeycodeScheme | undefined {
  return g instanceof AdvancedGate ? g.scheme : undefined;
}
