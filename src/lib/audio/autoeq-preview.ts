// The browser preview and the end-to-end tests don't reach GitHub: "Find your headphones" reads this small sample
// instead, in AutoEq's own formats (its results README and a ParametricEQ.txt). The models are real names; the filter
// values are made up for the preview and are not AutoEq's measurements.
export const PREVIEW_INDEX = [
  "- [7Hz Salnotes Zero:2](./oratory1990/in-ear/7Hz%20Salnotes%20Zero%3A2)",
  "- [7Hz Salnotes Zero](./crinacle/711%20in-ear/7Hz%20Salnotes%20Zero)",
  "- [Moondrop Chu II](./crinacle/711%20in-ear/Moondrop%20Chu%20II)",
  "- [Sennheiser HD 600](./oratory1990/over-ear/Sennheiser%20HD%20600)",
  "- [SteelSeries Arctis Nova 7](./Rtings/over-ear/SteelSeries%20Arctis%20Nova%207)",
].join("\n");

export const PREVIEW_PRESET = [
  "Preamp: -5.8 dB",
  "Filter 1: ON LSC Fc 105 Hz Gain 4.5 dB Q 0.70",
  "Filter 2: ON PK Fc 180 Hz Gain -2.0 dB Q 0.90",
  "Filter 3: ON PK Fc 2400 Hz Gain 2.2 dB Q 1.60",
  "Filter 4: ON PK Fc 5200 Hz Gain -3.4 dB Q 3.00",
  "Filter 5: ON HSC Fc 10000 Hz Gain -2.5 dB Q 0.70",
].join("\n");
