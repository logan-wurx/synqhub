// Which headphone picture a sound output name finds (the resolver the Sound page uses):
//   node scripts/device-photos/tools/phonecheck.mts "Sony WF-1000XM4" "Zero:2" ...
import { headphonePhotoKeyFor } from "../../../src/lib/device-images.ts";

for (const name of process.argv.slice(2)) console.log(`${name.padEnd(40)} -> ${headphonePhotoKeyFor(name) ?? "(drawn)"}`);
