// Govee's DIY effects as SYNQ builds them: the motion styles (family byte and variants) and the slot an uploaded
// effect is applied from. From the reference's H617A Type04 table (Fredde87/ha-govee-led-ble, MIT); every model whose
// table entry has `diy` takes them, all UNVERIFIED until the developer sees them (docs/devices/LIGHTING.md).

/** DIY styles: family byte, its variants, and whether it runs on speed or on the mic. */
export interface DiyStyle {
  family: number;
  name: string;
  variants: readonly { variant: number; name: string }[];
  rate: "speed" | "mic";
  combo: boolean;
}

export const DIY_STYLES: readonly DiyStyle[] = [
  { family: 0, name: "Fade", variants: [{ variant: 0, name: "Whole lamp" }, { variant: 1, name: "Sections" }, { variant: 2, name: "Cycle" }], rate: "speed", combo: true },
  { family: 1, name: "Jump", variants: [{ variant: 0, name: "Whole lamp" }, { variant: 2, name: "Cycle" }], rate: "speed", combo: true },
  { family: 2, name: "Flash", variants: [{ variant: 0, name: "Whole lamp" }, { variant: 1, name: "Sections" }, { variant: 2, name: "Cycle" }], rate: "speed", combo: true },
  { family: 3, name: "Marquee", variants: [{ variant: 3, name: "Together" }, { variant: 4, name: "Gather" }, { variant: 5, name: "Disperse" }], rate: "speed", combo: true },
  { family: 4, name: "Music", variants: [{ variant: 8, name: "Rhythm" }, { variant: 6, name: "Spectrum" }, { variant: 7, name: "Rolling" }], rate: "mic", combo: false },
  { family: 8, name: "Stream", variants: [{ variant: 9, name: "Forward" }, { variant: 10, name: "Backward" }], rate: "speed", combo: true },
  { family: 9, name: "Flow", variants: [{ variant: 9, name: "Forward" }, { variant: 10, name: "Backward" }], rate: "speed", combo: true },
  { family: 10, name: "Chase", variants: [{ variant: 0, name: "Default" }], rate: "speed", combo: false },
];
export const diyPairAllowed = (family: number, variant: number) => DIY_STYLES.some((s) => s.family === family && s.variants.some((v) => v.variant === variant));

/**
 * The DIY slot a DIY upload is applied with: 24 is the reference's Type04 apply code; 254 is the slot another
 * family's capture used. Both are allowed so the developer session can tell which the H6076 takes (UNVERIFIED).
 */
export const DIY_CODES: readonly number[] = [24, 254];
export const DIY_APPLY_CODE = 24;
