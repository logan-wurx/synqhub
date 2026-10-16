// probe.mts "kind|name|brand|vid:pid" ...: what the resolver gives for each device
import { photoKeyFor } from "../../../src/lib/device-images.ts";
for (const a of process.argv.slice(2)) {
  const [kind, name, brand, id] = a.split("|");
  const [vid, pid] = (id ?? "").split(":");
  console.log(a.padEnd(70), "->", photoKeyFor({ kind: kind as "mouse" | "keyboard", name, brand: brand || undefined, vid: vid || undefined, pid: pid || undefined }));
}
