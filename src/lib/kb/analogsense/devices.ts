// Analog keyboards whose key depth SYNQ can show live, and exactly what the HID bridge must allow
// for each. Read-only: nothing here configures a keyboard.
//
// From AnalogSense (MIT, Copyright (c) 2024 Calamity, Inc.):
//   [js:N]   https://github.com/AnalogSense/JavaScript-SDK AnalogSense.js line N (commit 6ba3f4a2, 2026-04-22),
//            the WebHID SDK behind analogsense.org
//   [soup:N] https://github.com/calamity-inc/Soup soup/AnalogueKeyboard.cpp line N (branch senpai,
//            fetched 2026-10-13), the C++ code the universal-analog-plugin
//            (https://github.com/AnalogSense/universal-analog-plugin, MIT) is built on
// Nothing here has been tried on hardware by SYNQ.

export type AnalogFamily = "wooting-v1" | "wooting-v2" | "razer-v2" | "razer-v3" | "nuphy" | "drunkdeer" | "keychron" | "madlions" | "bytech";

/** How the depth arrives. stream: the keyboard sends it unasked. poll: SYNQ asks, one request at a time. */
export type AnalogMode = "stream" | "poll";

export interface AnalogFamilyInfo {
  family: AnalogFamily;
  brand: string;
  mode: AnalogMode;
  /** Usage page / usage of the collection the depth comes from (usage null = any usage on that page). */
  usagePage: number | null;
  usage: number | null;
  /** Input report id carrying depth (null = the collection's only report). */
  inputReportId: number | null;
  /** Output report SYNQ sends to ask for depth (poll families only). */
  outputReportId: number | null;
  outputLength: number | null;
  /** Caveats the live view shows. */
  notes: readonly string[];
  source: string;
}

export const FAMILIES: Readonly<Record<AnalogFamily, AnalogFamilyInfo>> = {
  "wooting-v1": {
    family: "wooting-v1",
    brand: "Wooting",
    mode: "stream",
    usagePage: 0xff54,
    usage: null,
    inputReportId: null,
    outputReportId: null,
    outputLength: null,
    notes: ["Older Wooting analog interface (before firmware 2.13): up to 16 keys per report, 0..255."],
    source: "[js:344-375][soup:606-650]",
  },
  "wooting-v2": {
    family: "wooting-v2",
    brand: "Wooting",
    mode: "stream",
    usagePage: 0xff53,
    usage: null,
    inputReportId: null,
    outputReportId: null,
    outputLength: null,
    notes: ["Wooting analog interface v2 (firmware 2.13+ / Wootility 5.3+): 10-bit depth."],
    source: "[js:377-418][soup:652-695]",
  },
  "razer-v2": {
    family: "razer-v2",
    brand: "Razer",
    mode: "stream",
    usagePage: null,
    usage: null,
    inputReportId: 7,
    outputReportId: null,
    outputLength: null,
    notes: [
      "Razer only sends analog reports while Razer Synapse is running (it switches the keyboard into its analog device mode; SYNQ never does that itself).",
      "Which collection carries report 7 isn't recorded by AnalogSense; SYNQ only reads it if it isn't the keyboard collection.",
    ],
    source: "[js:420-457][soup:21-30][soup:57-72][soup:698-770]",
  },
  "razer-v3": {
    family: "razer-v3",
    brand: "Razer",
    mode: "stream",
    usagePage: null,
    usage: null,
    inputReportId: 11,
    outputReportId: null,
    outputLength: null,
    notes: [
      "Razer only sends analog reports while Razer Synapse is running (it switches the keyboard into its analog device mode; SYNQ never does that itself).",
      "Which collection carries report 11 isn't recorded by AnalogSense; SYNQ only reads it if it isn't the keyboard collection.",
    ],
    source: "[js:459-498][soup:73-94][soup:698-770]",
  },
  nuphy: {
    family: "nuphy",
    brand: "NuPhy",
    mode: "stream",
    usagePage: 0x0001,
    usage: 0x0000,
    inputReportId: null,
    outputReportId: null,
    outputLength: null,
    notes: ["NuPhy reports one key per change (report type 0xA0) on a Generic Desktop collection with usage 0; nothing is sent to it."],
    source: "[js:500-537][soup:172-178][soup:1071-1140]",
  },
  drunkdeer: {
    family: "drunkdeer",
    brand: "DrunkDeer",
    mode: "poll",
    usagePage: 0xff00,
    usage: null,
    inputReportId: null,
    outputReportId: 4,
    outputLength: 63,
    notes: ["DrunkDeer answers each request with three reports covering the whole board, in 0.1 mm."],
    source: "[js:539-598][soup:96-127][soup:772-905]",
  },
  keychron: {
    family: "keychron",
    brand: "Keychron",
    mode: "poll",
    usagePage: 0xff60,
    usage: 0x61,
    inputReportId: null,
    outputReportId: 0,
    outputLength: 32,
    notes: [
      "Official Keychron firmware only answers one key per request, so the view refreshes a few keys at a time; AnalogSense's custom firmware answers the whole board at once.",
      "Same collection as VIA: the analog request (0xA9) isn't a VIA command, so the bridge must apply the AnalogSense rules to these ids.",
    ],
    source: "[js:600-757][soup:129-170][soup:910-1069]",
  },
  madlions: {
    family: "madlions",
    brand: "Madlions",
    mode: "poll",
    usagePage: 0xff60,
    usage: 0x61,
    inputReportId: null,
    outputReportId: 0,
    outputLength: 32,
    notes: ["Madlions answers four keys per request, so the view refreshes a few keys at a time.", "Same collection as VIA, and the same USB vendor id as ATK mice."],
    source: "[js:759-850][soup:180-203][soup:1144-1230]",
  },
  bytech: {
    family: "bytech",
    brand: "Redragon",
    mode: "poll",
    usagePage: 0xff00,
    usage: null,
    inputReportId: null,
    outputReportId: 9,
    outputLength: 63,
    notes: ["BY3265H-based boards (hubx.pro software); only the Redragon K709 HE is listed. Not in the C++ plugin, so it rests on the WebHID SDK alone."],
    source: "[js:851-913]",
  },
};

export interface AnalogModel {
  family: AnalogFamily;
  name: string;
  vendorId: number;
  /** null = every product of this vendor (Wooting, NuPhy: "everything by ..."). */
  productId: number | null;
  /** Keychron / Madlions layout key (protocol.ts). */
  layout?: string;
  /** NuPhy depth scale: 1600 on the Air75 HE / Air60 HE, 800 on the rest. [soup:1115-1122] */
  scale?: number;
  source: string;
}

export const MODELS: readonly AnalogModel[] = [
  { family: "wooting-v2", name: "Wooting keyboard", vendorId: 0x31e3, productId: null, source: "[js:381]" },
  { family: "wooting-v1", name: "Wooting keyboard (analog v1)", vendorId: 0x31e3, productId: null, source: "[js:348]" },
  { family: "wooting-v1", name: "Wooting One (old firmware)", vendorId: 0x03eb, productId: 0xff01, source: "[js:349][soup:46-49]" },
  { family: "wooting-v1", name: "Wooting Two (old firmware)", vendorId: 0x03eb, productId: 0xff02, source: "[js:350][soup:50-53]" },
  { family: "razer-v2", name: "Razer Huntsman V2 Analog", vendorId: 0x1532, productId: 0x0266, source: "[js:424][soup:59]" },
  { family: "razer-v2", name: "Razer Huntsman Mini Analog", vendorId: 0x1532, productId: 0x0282, source: "[js:425][soup:66]" },
  { family: "razer-v3", name: "Razer Huntsman V3 Pro", vendorId: 0x1532, productId: 0x02a6, source: "[js:463][soup:73]" },
  { family: "razer-v3", name: "Razer Huntsman V3 Pro Tenkeyless", vendorId: 0x1532, productId: 0x02a7, source: "[js:464][soup:80]" },
  { family: "razer-v3", name: "Razer Huntsman V3 Pro Mini", vendorId: 0x1532, productId: 0x02b0, source: "[js:465][soup:87]" },
  { family: "nuphy", name: "NuPhy Air75 HE", vendorId: 0x19f5, productId: 0x6120, scale: 1600, source: "[soup:1115]" },
  { family: "nuphy", name: "NuPhy Air60 HE", vendorId: 0x19f5, productId: 0xfee0, scale: 1600, source: "[soup:1115]" },
  { family: "nuphy", name: "NuPhy HE keyboard", vendorId: 0x19f5, productId: null, scale: 800, source: "[js:504][soup:172-178]" },
  { family: "drunkdeer", name: "DrunkDeer G65", vendorId: 0x352d, productId: 0x2382, source: "[soup:100-103]" },
  { family: "drunkdeer", name: "DrunkDeer A75 / A75 Pro", vendorId: 0x352d, productId: 0x2383, source: "[soup:104-109]" },
  { family: "drunkdeer", name: "DrunkDeer G60", vendorId: 0x352d, productId: 0x2384, source: "[soup:110-113]" },
  { family: "drunkdeer", name: "DrunkDeer G75 (ANSI)", vendorId: 0x352d, productId: 0x2386, source: "[soup:114-117]" },
  { family: "drunkdeer", name: "DrunkDeer G75 (JP)", vendorId: 0x352d, productId: 0x2391, source: "[soup:118-121]" },
  { family: "keychron", name: "Keychron Q1 HE (ANSI)", vendorId: 0x3434, productId: 0x0b10, layout: "keychron-q1-he", source: "[js:604][soup:133]" },
  { family: "keychron", name: "Keychron Q1 HE (ISO)", vendorId: 0x3434, productId: 0x0b11, layout: "keychron-q1-he", source: "[js:605][soup:134]" },
  { family: "keychron", name: "Keychron Q1 HE (JIS)", vendorId: 0x3434, productId: 0x0b12, layout: "keychron-q1-he", source: "[js:606][soup:135]" },
  { family: "keychron", name: "Keychron Q3 HE (ANSI)", vendorId: 0x3434, productId: 0x0b30, layout: "keychron-q3-he", source: "[js:607][soup:140]" },
  { family: "keychron", name: "Keychron Q5 HE (ANSI)", vendorId: 0x3434, productId: 0x0b50, layout: "keychron-q5-he", source: "[js:608][soup:144]" },
  { family: "keychron", name: "Keychron K2 HE (ANSI)", vendorId: 0x3434, productId: 0x0e20, layout: "keychron-k2-he", source: "[js:609][soup:148]" },
  { family: "keychron", name: "Keychron K2 HE (ISO)", vendorId: 0x3434, productId: 0x0e21, layout: "keychron-k2-he", source: "[js:610][soup:149]" },
  { family: "keychron", name: "Keychron K2 HE (JIS)", vendorId: 0x3434, productId: 0x0e22, layout: "keychron-k2-he", source: "[js:611][soup:150]" },
  { family: "keychron", name: "Lemokey P1 HE (ANSI)", vendorId: 0x362d, productId: 0x0610, layout: "lemokey-p1-he-ansi", source: "[js:612][soup:161]" },
  { family: "keychron", name: "Lemokey P1 HE (ISO)", vendorId: 0x362d, productId: 0x0611, layout: "lemokey-p1-he-iso", source: "[soup:165]" },
  { family: "madlions", name: "Madlions MAD60HE", vendorId: 0x373b, productId: 0x1053, layout: "madlions-mad60he", source: "[js:764][soup:186]" },
  { family: "madlions", name: "Madlions MAD60HE", vendorId: 0x373b, productId: 0x1054, layout: "madlions-mad60he", source: "[js:765][soup:187]" },
  { family: "madlions", name: "Madlions MAD60HE", vendorId: 0x373b, productId: 0x1055, layout: "madlions-mad60he", source: "[js:766][soup:185]" },
  { family: "madlions", name: "Madlions MAD60HE", vendorId: 0x373b, productId: 0x1056, layout: "madlions-mad60he", source: "[js:767][soup:185]" },
  { family: "madlions", name: "Madlions MAD60HE", vendorId: 0x373b, productId: 0x105d, layout: "madlions-mad60he", source: "[js:768][soup:185]" },
  { family: "madlions", name: "Madlions MAD68HE", vendorId: 0x373b, productId: 0x1058, layout: "madlions-mad68he", source: "[js:770][soup:192]" },
  { family: "madlions", name: "Madlions MAD68HE", vendorId: 0x373b, productId: 0x1059, layout: "madlions-mad68he", source: "[js:771][soup:192]" },
  { family: "madlions", name: "Madlions MAD68HE", vendorId: 0x373b, productId: 0x105a, layout: "madlions-mad68he", source: "[js:772][soup:192]" },
  { family: "madlions", name: "Madlions MAD68HE", vendorId: 0x373b, productId: 0x105c, layout: "madlions-mad68he", source: "[js:773][soup:192]" },
  { family: "madlions", name: "Madlions MAD68R", vendorId: 0x373b, productId: 0x10a7, layout: "madlions-mad68he", source: "[js:775][soup:196]" },
  { family: "bytech", name: "Redragon K709 HE (K709PLB-RGB-M)", vendorId: 0x372e, productId: 0x105b, source: "[js:858]" },
];

export interface CollectionLike {
  usagePage?: number;
  usage?: number;
  inputReports?: readonly { reportId?: number }[];
}

export interface DeviceLike {
  vendorId: number;
  productId: number;
  productName?: string;
  collections?: readonly CollectionLike[];
}

/** Usage pages that carry typing or pointing; never read for depth, except NuPhy's page 1 / usage 0 analog collection. */
const KEYBOARD_COLLECTIONS: readonly [number, number][] = [
  [0x0001, 0x0006], // Generic Desktop / Keyboard
  [0x0001, 0x0007], // Keypad
  [0x0001, 0x0002], // Mouse
  [0x0001, 0x0080], // System Control
  [0x000c, 0x0001], // Consumer Control
];
const isTypingCollection = (c: CollectionLike) => c.usagePage === 0x0007 || KEYBOARD_COLLECTIONS.some(([p, u]) => p === c.usagePage && u === c.usage);

/** The collection depth comes from, or null. No I/O: ids and collections only. */
export function depthCollection(model: AnalogModel, collections: readonly CollectionLike[]): CollectionLike | null {
  const f = FAMILIES[model.family];
  for (const c of collections) {
    if (isTypingCollection(c)) continue;
    if (f.inputReportId !== null) {
      // Razer: the collection that declares the analog report id, as AnalogSense matches it [js:961-976].
      if (c.inputReports?.some((r) => r.reportId === f.inputReportId)) return c;
      continue;
    }
    if (c.usagePage === f.usagePage && (f.usage === null || c.usage === f.usage)) return c;
  }
  return null;
}

/** The listed model for a device (the exact product first, then the vendor-wide entry whose collection is present). */
export function findModel(d: DeviceLike): AnalogModel | null {
  const exact = MODELS.filter((m) => m.vendorId === d.vendorId && m.productId === d.productId);
  const wide = MODELS.filter((m) => m.vendorId === d.vendorId && m.productId === null);
  for (const m of [...exact, ...wide]) {
    if (!d.collections?.length || depthCollection(m, d.collections)) return m;
  }
  return null;
}

/**
 * What the bridge must allow for live depth, per vendor. Never a keyboard (page 7 / Generic Desktop
 * keyboard), mouse, consumer or system-control collection. Feature reports: none for any family.
 */
export const ANALOGSENSE_BRIDGE: readonly { vendorId: number; productIds: readonly number[] | "all"; usagePage: number | null; usage: number | null; input: string; output: string | null; note?: string }[] = [
  { vendorId: 0x31e3, productIds: "all", usagePage: 0xff54, usage: null, input: "any (depth stream v1)", output: null },
  { vendorId: 0x31e3, productIds: "all", usagePage: 0xff53, usage: null, input: "any (depth stream v2)", output: null },
  { vendorId: 0x03eb, productIds: [0xff01, 0xff02], usagePage: 0xff54, usage: null, input: "any (depth stream v1)", output: null, note: "0x03EB is Atmel's vendor id: these two products only." },
  { vendorId: 0x1532, productIds: [0x0266, 0x0282], usagePage: null, usage: null, input: "report 7 only", output: null, note: "Only the collection that declares input report 7, and only if it isn't the keyboard / consumer / system collection; otherwise unsupported." },
  { vendorId: 0x1532, productIds: [0x02a6, 0x02a7, 0x02b0], usagePage: null, usage: null, input: "report 11 only", output: null, note: "As above, report 11." },
  { vendorId: 0x19f5, productIds: "all", usagePage: 0x0001, usage: 0x0000, input: "any (type 0xA0 reports)", output: null, note: "Generic Desktop page with usage 0 (not keyboard): needs an exception to the bridge's input-page rule." },
  { vendorId: 0x352d, productIds: [0x2382, 0x2383, 0x2384, 0x2386, 0x2391], usagePage: 0xff00, usage: null, input: "any", output: "report 4, 63 bytes, one fixed frame" },
  { vendorId: 0x3434, productIds: [0x0b10, 0x0b11, 0x0b12, 0x0b30, 0x0b50, 0x0e20, 0x0e21, 0x0e22], usagePage: 0xff60, usage: 0x61, input: "any", output: "report 0, 32 bytes, 0xA9 01 / 30 / 31 only", note: "VIA's collection: AnalogSense rules for these ids." },
  { vendorId: 0x362d, productIds: [0x0610, 0x0611], usagePage: 0xff60, usage: 0x61, input: "any", output: "report 0, 32 bytes, 0xA9 01 / 30 / 31 only", note: "VIA's collection: AnalogSense rules for these ids." },
  { vendorId: 0x373b, productIds: [0x1053, 0x1054, 0x1055, 0x1056, 0x105d, 0x1058, 0x1059, 0x105a, 0x105c, 0x10a7], usagePage: 0xff60, usage: 0x61, input: "any", output: "report 0, 32 bytes, 02 96 1C ... offset 04 only", note: "Same vendor id as ATK mice: list these products explicitly." },
  { vendorId: 0x372e, productIds: [0x105b], usagePage: 0xff00, usage: null, input: "any", output: "report 9, 63 bytes, one fixed frame" },
];

export function analogCoverage() {
  const explicit = MODELS.filter((m) => m.productId !== null);
  return {
    brands: [...new Set(MODELS.map((m) => FAMILIES[m.family].brand === "Keychron" && m.vendorId === 0x362d ? "Lemokey" : FAMILIES[m.family].brand))],
    families: Object.keys(FAMILIES).length,
    explicitProducts: explicit.length,
    explicitModels: new Set(explicit.map((m) => m.name.replace(/ \((ANSI|ISO|JIS)\)$/, ""))).size,
    vendorWide: MODELS.filter((m) => m.productId === null).map((m) => m.name),
  };
}
