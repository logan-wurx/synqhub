// Settings on the website: where backups and logs are kept (this browser's storage), with the buttons the
// desktop app doesn't need: download a backup, download all of them, restore from a file, download the
// logs, and forget the devices this browser was given. Nothing here talks to a device.
import { useCallback, useEffect, useRef, useState } from "react";
import { DownloadSimple, UploadSimple, Warning } from "@phosphor-icons/react";
import { Card, CardHeader } from "@/components/ui/matte";
import type { BackupMeta, WebStore } from "@/lib/web/store";

const btn = "rounded-full px-3.5 py-1.5 text-[12.5px] text-foreground ring-1 ring-white/10 transition-colors hover:bg-white/[0.06] disabled:opacity-40";

/** Saves text as a file through the browser's download. */
export function downloadText(fileName: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

export function WebData() {
  const [store, setStore] = useState<WebStore | null>(null);
  const [list, setList] = useState<BackupMeta[]>([]);
  const [say, setSay] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (s: WebStore) => setList(await s.listBackups()), []);
  useEffect(() => {
    void import("@/lib/web/store").then(async (m) => {
      const s = await m.browserStore();
      setStore(s);
      await refresh(s);
    });
  }, [refresh]);

  const guard = (f: (s: WebStore) => Promise<void>) => async () => {
    if (!store) return;
    try {
      await f(store);
    } catch (e) {
      setSay({ tone: "bad", text: String((e as Error)?.message ?? e) });
    }
  };

  const downloadOne = (name: string) =>
    guard(async (s) => {
      const json = await s.readBackup(name);
      if (json) downloadText(name, json);
    });

  const downloadAll = guard(async (s) => {
    const bundle = await s.exportAll();
    downloadText(`onboard-backups-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 1));
  });

  const downloadLogs = guard(async (s) => {
    const names = await s.logNames();
    const parts = await Promise.all(names.map(async (n) => `=== ${n} ===\n${await s.readLog(n)}\n`));
    downloadText(`onboard-logs-${new Date().toISOString().slice(0, 10)}.txt`, parts.join("\n") || "No changes have been logged in this browser.\n", "text/plain");
  });

  const restore = async (f: File | undefined) => {
    if (!f || !store) return;
    try {
      const r = await store.restore(f.name, await f.text());
      await refresh(store);
      setSay({ tone: "ok", text: `Restored ${r.backups} backup${r.backups === 1 ? "" : "s"}${r.states ? ` and ${r.states} saved setting${r.states === 1 ? "" : "s"}` : ""}.` });
    } catch (e) {
      setSay({ tone: "bad", text: String((e as Error)?.message ?? e) });
    } finally {
      if (file.current) file.current.value = "";
    }
  };

  const forget = guard(async () => {
    const { forgetAllDevices } = await import("@/lib/web/hid");
    const n = await forgetAllDevices();
    setSay({ tone: "ok", text: n ? `This browser forgot ${n} device${n === 1 ? "" : "s"}. Add them again when you want them.` : "No devices were added in this browser." });
  });

  return (
    <Card>
      <CardHeader
        title="Backups and logs"
        hint="Kept in this browser only. Download them to keep a copy, or to move to another browser."
        right={
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btn} onClick={() => void downloadAll()} disabled={!list.length}>
              <DownloadSimple size={13} className="mr-1.5 inline -mt-0.5" />
              Download all
            </button>
            <button type="button" className={btn} onClick={() => file.current?.click()}>
              <UploadSimple size={13} className="mr-1.5 inline -mt-0.5" />
              Restore from file
            </button>
            <input ref={file} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void restore(e.target.files?.[0])} />
          </div>
        }
      />
      <div className="px-5 pb-5 pt-3">
        {store && !store.persistent && (
          <p className="mb-3 flex items-start gap-2 rounded-xl bg-chart-3/[0.06] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-chart-3 ring-1 ring-chart-3/20">
            <Warning size={16} weight="light" className="mt-0.5 shrink-0" />
            This browser won't keep storage (a private window, or site data is blocked), so backups last only until you close this tab. Download them first.
          </p>
        )}
        {list.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">No backups yet. SYNQ saves one here before the first change to a device.</p>
        ) : (
          <ul className="divide-y divide-white/[0.05]" data-slot="backup-list">
            {list.slice(0, 8).map((b) => (
              <li key={b.name} className="flex items-center gap-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {b.name}
                  <span className="ml-2 text-[11.5px] text-muted-foreground">{when(b.savedAt)}</span>
                </span>
                <span className="tabular shrink-0 text-[11.5px] text-muted-foreground">{size(b.bytes)}</span>
                <button type="button" className={btn} onClick={() => void downloadOne(b.name)()}>
                  Download backup
                </button>
              </li>
            ))}
            {list.length > 8 && <li className="py-2 text-[12px] text-muted-foreground">and {list.length - 8} older. "Download all" has every one.</li>}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.05] pt-4">
          <button type="button" className={btn} onClick={() => void downloadLogs()}>
            Download logs
          </button>
          <button type="button" className={btn} onClick={() => void forget()}>
            Forget my devices
          </button>
          {say && <span className={say.tone === "ok" ? "text-[12.5px] text-muted-foreground" : "text-[12.5px] text-destructive"}>{say.text}</span>}
        </div>
      </div>
    </Card>
  );
}
