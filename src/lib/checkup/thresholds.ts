// Every number the checkup judges by, in one place. A finding turns yellow or red only when a measurement
// crosses one of these; nothing else in src/lib/checkup picks a colour. Times are in ms.
//
// The human limits come from tapping studies: the fastest people tap one finger about 10 times a second, so a
// button or key that is pressed again within ~20 ms of letting go was not pressed by a finger.

export const CLICKS = {
  /** Presses asked for in the click step. */
  target: 30,
  /** Below this many presses the step says nothing about the button (too few to judge). */
  minPresses: 12,
  /** A press that starts this soon after the same button let go is the switch bouncing, not a finger. */
  chatterGapMs: 20,
  /** One bounce is yellow (it can be a fluke); this many is red. */
  badCount: 3,
  /** A debounce fix is the smallest the mouse offers above the longest bounce seen plus this. */
  debounceMarginMs: 2,
} as const;

export const MOTION = {
  /** How long the circles step lasts. */
  seconds: 4,
  /** Fewer motion reports than this and polling isn't judged. */
  minReports: 150,
  /** A pause longer than this is the hand stopping, not a dropped report. */
  idleGapMs: 50,
  /**
   * A stretch only counts toward the rate when its reports carry at least this many counts on average: slower than
   * that, the sensor has nothing new for some polls and sends nothing, which would read as a low rate.
   */
  saturatedCounts: 2,
  /** Time slices the delivered rate is counted in (at least 10 polls each). */
  windowMs: 20,
  /** Measured rate below this share of the set rate: "runs slower than it's set to". */
  slowShare: 0.8,
  /** A silence this long in the middle of a fast circle is a dropout (no PC hiccup is this long). */
  dropoutMs: 10,
  /** Dropouts: this share of the moving time lost, or this many dropouts, is yellow; the red share below. */
  dropWarnPct: 1,
  dropWarnCount: 3,
  dropBadPct: 5,
  /** Uneven delivery: the slices' report counts vary by more than this (coefficient of variation). */
  unevenCv: 0.35,
  /** A report this many times bigger than its neighbours, and at least jumpMinCounts, is a sensor jump. */
  jumpFactor: 8,
  jumpMinCounts: 20,
  /** Neighbours on each side a report is compared with. */
  jumpSpan: 5,
  /** Polling a wireless mouse is set above this is the first thing to lower when it drops reports. */
  wirelessSafeHz: 2000,
  /** The rate a fix lowers an unstable wired mouse to. */
  stableHz: 1000,
} as const;

export const REST = {
  /** How long the hands-off step lasts. */
  seconds: 2,
  /** Motion summed over the hands-off step (counts) above which the mouse "moved on its own". */
  mouseCounts: 6,
  /** Motion reports needed before that counts (one bump of the desk isn't a finding). */
  mouseReports: 4,
} as const;

export const KEYS = {
  /** Keys asked for in the key step, by `KeyboardEvent.code`. */
  codes: ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "Space"] as readonly string[],
  /** A key pressed again this soon after it let go is the switch (or rapid trigger), not a finger. */
  chatterGapMs: 25,
  badCount: 3,
  /** A key still down this long after the step's last event never came back up. */
  stuckAfterMs: 400,
} as const;

export const HOLD = {
  /** The key held in the hold step, and for how long. */
  code: "KeyW",
  seconds: 2,
  /** A release followed by a press within this is the key flickering, not the person letting go. */
  toggleGapMs: 150,
  /** Releases while the key is held: one is yellow, this many red. */
  badToggles: 3,
  /** A rapid-trigger fix raises the sensitivity to at least this (most people's fingers move less while holding). */
  rtSafeMm: 0.15,
  /** ... and at least this multiple of what it was. */
  rtFactor: 2,
} as const;

export const STICKS = {
  /** How long the spin step lasts. */
  seconds: 5,
  /** Stick offset at rest (share of the radius): yellow, red. Games' own inner dead zones are usually 5-15%. */
  driftWarn: 0.05,
  driftBad: 0.1,
  /** Circularity error (% of the radius): yellow, red. */
  roundWarnPct: 12,
  roundBadPct: 20,
  /** Bins of the 72 a spin must reach before circularity is judged. */
  minBins: 36,
  /** A dead-zone fix covers the drift seen plus this (share of the radius). */
  deadzoneMargin: 0.03,
} as const;

export const AUDIO = {
  /** The EQ's net peak above this (dB) can clip. */
  clipDb: 0,
  /** Left/right level difference in the config: yellow, red (dB). */
  balanceWarnDb: 1,
  balanceBadDb: 3,
} as const;
