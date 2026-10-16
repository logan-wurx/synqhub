// Where the generic mouse panel keeps its backups and its write log. The desktop app saves them in
// its data folder (tauri-store.ts); a website version could download the backup or keep it in the
// browser. This file has no Tauri dependency.

export interface MouseStore {
  /** Saves `json` before the first change to a mouse; returns where it went. */
  saveBackup(prefix: string, json: string): Promise<string>;
  /** Appends lines to the mouse's write log. */
  log(prefix: string, lines: string[]): Promise<void>;
}

/** In-memory store, for the browser preview and the tests. */
export function memoryStore(): MouseStore & { backups: { prefix: string; json: string }[]; lines: string[] } {
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

/** File-name-safe slug: letters, digits and dashes. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "mouse";
