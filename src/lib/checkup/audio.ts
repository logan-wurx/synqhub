// The sound half of the checkup: read only, from what SYNQ already has. Whether the EQ engine runs on the output,
// what Windows says is in its way, whether the EQ can clip, and whether left and right are set to different levels
// in the config. It plays nothing.

export interface ChannelLevels {
  /** Net preamp of each channel the config scopes (dB): "L", "R"... */
  byChannel: Record<string, number>;
  /** Left minus right (dB); null when the config doesn't treat them differently. */
  balanceDb: number | null;
}

const CHANNEL_ALIASES: Record<string, string> = { "1": "L", "2": "R", LEFT: "L", RIGHT: "R" };

/**
 * Per-channel preamps from Equalizer APO config lines (`Channel: L` then `Preamp: -2 dB`). Lines that apply to
 * every channel add to both. Anything else (filters, Copy, includes) is left alone: this only reads levels.
 */
export function channelLevels(text: string | null): ChannelLevels {
  const levels: Record<string, number> = {};
  let scope: string[] | null = null;
  let common = 0;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const ch = /^Channel:\s*(.+)$/i.exec(line);
    if (ch) {
      const names = ch[1].trim().split(/\s+/).map((n) => CHANNEL_ALIASES[n.toUpperCase()] ?? n.toUpperCase());
      scope = names.includes("ALL") ? null : names;
      continue;
    }
    const pre = /^Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(line);
    if (!pre) continue;
    const db = Number(pre[1]);
    if (scope === null) common += db;
    else for (const n of scope) levels[n] = (levels[n] ?? 0) + db;
  }
  const byChannel: Record<string, number> = {};
  for (const [n, db] of Object.entries(levels)) byChannel[n] = db + common;
  const l = levels.L;
  const r = levels.R;
  const balanceDb = l === undefined && r === undefined ? null : (l ?? 0) - (r ?? 0);
  return { byChannel, balanceDb: balanceDb === 0 ? null : balanceDb };
}
