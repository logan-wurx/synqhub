// Where the website keeps what the desktop app keeps in its data folder: the backup saved before a
// device's first change, the write logs, the Falchion / X68 HE settings copies and the cached VIA
// layouts. They live in this browser's IndexedDB (nothing leaves the machine), and the person can
// download them ("Download backup") and put them back ("Restore from file"). Settings such as the
// accent stay in localStorage, always inside try/catch (src/lib/web/settings.ts).
//
// `createWebStore(kv)` takes the storage underneath, so the tests run it on a Map; `browserStore()` is
// IndexedDB, falling back to memory when the browser won't give storage (a private window), and says so
// in `persistent` so the page can tell the person to download their backups.

export interface Kv {
  get(table: Table, key: string): Promise<string | undefined>;
  put(table: Table, key: string, value: string): Promise<void>;
  delete(table: Table, key: string): Promise<void>;
  keys(table: Table): Promise<string[]>;
}

export type Table = "backups" | "logs" | "states" | "definitions";

export interface BackupMeta {
  /** The file name it downloads as: "<prefix>-20261014-101500.json". */
  name: string;
  prefix: string;
  savedAt: number;
  bytes: number;
}

interface BackupRecord extends BackupMeta {
  json: string;
}

/** The bundle "Download all" writes and "Restore from file" reads back. */
export interface BackupBundle {
  format: "onboard-web-backup";
  version: 1;
  exportedAt: string;
  backups: { name: string; prefix: string; savedAt: number; json: string }[];
  states: { key: string; json: string }[];
}

export const BUNDLE_FORMAT = "onboard-web-backup";
/** Lines kept per write log. */
export const LOG_LINES = 2000;
/** The biggest file "Restore from file" takes. */
export const MAX_RESTORE_BYTES = 8 * 1024 * 1024;

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "backup";

const stamp = (t: number) => {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

export interface WebStore {
  /** False when the browser wouldn't give storage: everything is kept for this tab only. */
  readonly persistent: boolean;
  saveBackup(prefix: string, json: string): Promise<string>;
  log(prefix: string, lines: string[]): Promise<void>;
  loadState(key: string): Promise<string | null>;
  saveState(key: string, json: string): Promise<void>;
  loadDefinition(key: string): Promise<string | null>;
  saveDefinition(key: string, json: string): Promise<void>;
  listBackups(): Promise<BackupMeta[]>;
  readBackup(name: string): Promise<string | null>;
  deleteBackup(name: string): Promise<void>;
  /** Every backup and settings copy in one JSON file. */
  exportAll(): Promise<BackupBundle>;
  /** A single log, as text. */
  readLog(prefix: string): Promise<string>;
  logNames(): Promise<string[]>;
  /** Puts a downloaded backup (one file, or the "all" bundle) back. */
  restore(fileName: string, text: string): Promise<{ backups: number; states: number }>;
}

export function createWebStore(kv: Kv, persistent = true, now: () => number = Date.now): WebStore {
  const putBackup = async (r: BackupRecord) => kv.put("backups", r.name, JSON.stringify(r));
  const getBackup = async (name: string): Promise<BackupRecord | null> => {
    const text = await kv.get("backups", name);
    if (!text) return null;
    try {
      return JSON.parse(text) as BackupRecord;
    } catch {
      return null;
    }
  };
  /** A free file name for this prefix and moment. */
  const freeName = async (prefix: string, t: number) => {
    const base = `${slugOf(prefix)}-${stamp(t)}`;
    const taken = new Set(await kv.keys("backups"));
    let name = `${base}.json`;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}.json`;
    return name;
  };

  return {
    persistent,
    async saveBackup(prefix, json) {
      const t = now();
      const name = await freeName(prefix, t);
      await putBackup({ name, prefix, savedAt: t, bytes: json.length, json });
      return `browser storage: ${name}`;
    },
    async log(prefix, lines) {
      if (!lines.length) return;
      const key = slugOf(prefix);
      const old = (await kv.get("logs", key)) ?? "";
      const all = (old ? old.split("\n") : []).concat(lines);
      await kv.put("logs", key, all.slice(-LOG_LINES).join("\n"));
    },
    loadState: async (key) => (await kv.get("states", slugOf(key))) ?? null,
    saveState: (key, json) => kv.put("states", slugOf(key), json),
    loadDefinition: async (key) => (await kv.get("definitions", key)) ?? null,
    saveDefinition: (key, json) => kv.put("definitions", key, json),
    async listBackups() {
      const out: BackupMeta[] = [];
      for (const name of await kv.keys("backups")) {
        const r = await getBackup(name);
        if (r) out.push({ name: r.name, prefix: r.prefix, savedAt: r.savedAt, bytes: r.bytes });
      }
      return out.sort((a, b) => b.savedAt - a.savedAt);
    },
    async readBackup(name) {
      return (await getBackup(name))?.json ?? null;
    },
    deleteBackup: (name) => kv.delete("backups", name),
    async exportAll() {
      const backups: BackupBundle["backups"] = [];
      for (const name of await kv.keys("backups")) {
        const r = await getBackup(name);
        if (r) backups.push({ name: r.name, prefix: r.prefix, savedAt: r.savedAt, json: r.json });
      }
      const states: BackupBundle["states"] = [];
      for (const key of await kv.keys("states")) {
        const json = await kv.get("states", key);
        if (json) states.push({ key, json });
      }
      return { format: BUNDLE_FORMAT, version: 1, exportedAt: new Date(now()).toISOString(), backups: backups.sort((a, b) => a.savedAt - b.savedAt), states };
    },
    readLog: async (prefix) => (await kv.get("logs", slugOf(prefix))) ?? "",
    logNames: () => kv.keys("logs"),
    async restore(fileName, text) {
      if (text.length > MAX_RESTORE_BYTES) throw new Error("That file is too big to be one of SYNQ's backups.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("That file isn't JSON, so it isn't one of SYNQ's backups.");
      }
      const bundle = parsed as Partial<BackupBundle> | null;
      if (bundle && typeof bundle === "object" && bundle.format === BUNDLE_FORMAT) {
        if (bundle.version !== 1 || !Array.isArray(bundle.backups) || !Array.isArray(bundle.states)) throw new Error("That backup bundle is from a version SYNQ doesn't read.");
        let backups = 0;
        for (const b of bundle.backups) {
          if (typeof b?.name !== "string" || typeof b.json !== "string") continue;
          const name = (await getBackup(b.name)) ? await freeName(b.prefix || "restored", now()) : slugOf(b.name.replace(/\.json$/, "")) + ".json";
          await putBackup({ name, prefix: String(b.prefix ?? "restored"), savedAt: Number(b.savedAt) || now(), bytes: b.json.length, json: b.json });
          backups++;
        }
        let states = 0;
        for (const s of bundle.states) {
          if (typeof s?.key !== "string" || typeof s.json !== "string") continue;
          await kv.put("states", slugOf(s.key), s.json);
          states++;
        }
        return { backups, states };
      }
      // Any other JSON file is one device backup, kept under the name it came with.
      const base = slugOf(fileName.replace(/\.json$/i, ""));
      const t = now();
      const name = await freeName(base, t);
      await putBackup({ name, prefix: base, savedAt: t, bytes: text.length, json: text });
      return { backups: 1, states: 0 };
    },
  };
}

/** Storage in memory: the tests, and the fallback when IndexedDB isn't there. */
export function memoryKv(): Kv & { tables: Map<Table, Map<string, string>> } {
  const tables = new Map<Table, Map<string, string>>();
  const t = (table: Table) => {
    let m = tables.get(table);
    if (!m) tables.set(table, (m = new Map()));
    return m;
  };
  return {
    tables,
    get: async (table, key) => t(table).get(key),
    put: async (table, key, value) => void t(table).set(key, value),
    delete: async (table, key) => void t(table).delete(key),
    keys: async (table) => [...t(table).keys()],
  };
}

const TABLES: Table[] = ["backups", "logs", "states", "definitions"];
const DB_NAME = "onboard-web";

/** IndexedDB, opened once. Rejects when the browser won't give storage. */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB isn't available"));
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => {
      for (const t of TABLES) if (!req.result.objectStoreNames.contains(t)) req.result.createObjectStore(t);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed to open"));
    req.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });
}

function idbKv(db: IDBDatabase): Kv {
  const run = <T,>(table: Table, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(table, mode);
      const req = f(tx.objectStore(table));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB was aborted"));
    });
  return {
    get: (table, key) => run<string | undefined>(table, "readonly", (s) => s.get(key)),
    put: (table, key, value) => run(table, "readwrite", (s) => s.put(value, key)).then(() => undefined),
    delete: (table, key) => run(table, "readwrite", (s) => s.delete(key)).then(() => undefined),
    keys: (table) => run<IDBValidKey[]>(table, "readonly", (s) => s.getAllKeys()).then((k) => k.map(String)),
  };
}

let shared: Promise<WebStore> | null = null;

/** This browser's store: IndexedDB when it works, memory (with `persistent: false`) when it doesn't. */
export function browserStore(): Promise<WebStore> {
  shared ??= openDb().then(
    (db) => createWebStore(idbKv(db), true),
    (e) => {
      console.warn("[onboard web] browser storage isn't available; backups are kept for this tab only", e);
      return createWebStore(memoryKv(), false);
    },
  );
  return shared;
}
