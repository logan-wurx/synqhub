// Spring presets used by the segmented tabs' sliding indicators.
export const spring = {
  moderate: { type: "spring", stiffness: 520, damping: 42, mass: 0.9 },
  fast: {
    type: "spring",
    stiffness: 760,
    damping: 48,
    mass: 0.7,
    exit: { duration: 0.12 },
  },
} as const;
