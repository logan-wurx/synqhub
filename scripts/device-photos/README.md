# Device pictures: how `src/assets/devices` was made

A record of the pipeline, kept next to the result. Python 3 with Pillow, numpy and requests; nothing here talks to a
device and nothing downloaded is ever executed.

1. `tools/vendors/<vendor>.py` lists the models of one maker, each with the official page, configurator or depot the
   picture comes from (the makers' own sites and apps only) and the USB ids and names that identify the device.
2. `tools/build.py <vendor>` fetches the pictures (cached under `cache/`) and runs `tools/proc.py` on each: pictures that
   are already transparent are kept; a flat white or black background is cut with an edge flood fill and a soft alpha
   (the way `atk-cut/cut.py` did the X1); only the biggest piece is kept (dongles, captions and boxes go);
   the result is trimmed and written as WebP, about 600 px on the long side and 15-40 KB.
3. Store pages show several photos per product, so `tools/cands.py <vendor>` draws review sheets with an index on each
   cut-out, and the chosen index per model goes in `picks/<vendor>.json` (a model with no usable top-down picture is
   left out and falls back to a drawing).
4. `tools/assemble.py` copies the result to `src/assets/devices/<vendor>/<key>.webp` and writes `index.json` and
   `SOURCES.json`; then `node scripts/gen-device-images.mjs` writes `src/lib/device-images.generated.ts`.

## Second pass (every claimed model gets a picture)

Run with a scratch venv that has `rembg` + `onnxruntime` (`pip install "rembg[cpu]"`; the `isnet-general-use` weights download on first use).
Nothing here is ever executed from a download, and the Wayback Machine is asked politely (one request every few seconds).

* `tools/proc2.py` + `tools/matte.py`: like `proc.py`, but a picture that is not really transparent is matted with rembg
  (cached by content), then the same trim / biggest-piece / WebP steps. `FORCE` in a vendor module matters when a stray
  transparent corner hides an opaque white background.
* `tools/cands2.py <vendor>` draws the review sheets (`qa/c2-<vendor>-N.png`, rembg applied to every candidate, five worker
  processes); a pick per model goes in `picks/<vendor>.json`; `tools/build2.py <vendor>` writes `out/<vendor>/`.
* Sources, in the order tried: OpenMouse's own image bucket (`vendors/omimg.py`), the makers' own sites and stores
  (`stores2/3`, `logitech2`, `corsair2`, `asus2`, `steelseries3`, `razer3` = the 500 px store thumbnails the razer.com pages
  still link to), the Wayback Machine for pages the makers took down (`razer2`, `wayback3`), and last the mouse database
  mouselog.jp (`mouselog`) and retailer listings (`retail2/3`, rows in `tools/retail3-rows.json`). Every picture's source is in
  `src/assets/devices/SOURCES.json`.
* `tools/assemble2.py` MERGES into `src/assets/devices` (it never removes), applies `aliases.json` (same-shell models share one
  picture: wired / wireless / dongle ids, colour and revision names, family photos where a maker never published one) and
  rewrites `index.json` / `SOURCES.json`; then `node scripts/gen-device-images.mjs`.
* `tools/coverage2.mts` (and `coverage_om_all.mts`) count, per list, how many claimed models resolve to a picture (pass
  the folder with the candidate lists);
  `tools/probe.mts "kind|name|brand|vid:pid"` shows what the resolver gives for one device.

The vendor scripts and the data files next to them (`om-supported.json`, `catalog-raw.json`, ...) are the inputs as they
were on 2026-10-14. A few of the first-step scripts (`logi_scan.py`, `atk_parse.py`, `razer_scrape.py`) read research
downloads that are not in the repository.

## Third pass (0x19F5 family and Royal Kludge BeiYing)

`tools/vendors/kb4.py` covers NuPhy (pay.nuphy.com), MCHOSE (mchose.store) and Royal Kludge (rkgamingstore.com), the makers' own Shopify stores. Its rows
(`tools/gen_kb4_rows.mjs` prints them from the drivers' model tables) list every USB id of the models that share a shell, so the resolver finds a picture
by id. Same steps as the second pass: `cands2.py kb4` draws the review sheets, picks go in `picks/kb4.json`, `build2.py kb4` writes `out/kb4/`, and
`assemble2.py` merges into `src/assets/devices` (plus the new `mchose-jet75` ids in `aliases.json`). 38 pictures; the ids that two models share
(`3837:3033`, four MCHOSE boards) are on no picture. Models with no official picture (Ace 75, G75 V2, G87 V2, K87S, ZERO 75X, NuPhy Halo Lite / Halo HE /
Type2nd, RK Gcome K99 / T98 / T87 / R98Pro GT, most older BeiYing boards) are drawn from their layout.

## Fourth pass (wave B: Keychron / Lemokey HE, Redragon on illumipc, Epomaker, SparkLink Royal Kludge)

`tools/vendors/kb5.py` reads `tools/kb5-rows.json`, which `tools/gen_kb5_rows.mjs` writes from the drivers' own tables (the Keychron HE catalogue, the illumipc
catalogue, the SparkLink model list), so a new model only needs a row there. Pictures are from the makers' own Shopify stores (keychron.com, www.lemokey.com,
redragonshop.com, epomaker.com, rkgamingstore.com). This pass used the flood-fill pipeline only (`cands.py kb5` for the review sheets, picks in `picks/kb5.json`,
`build.py kb5`, then `assemble2.py`): no matting model was installed, so only pictures on a plain studio background were kept (the Redragon K617, Royal Kludge C84 and C98 pictures keep a small cable stub or clip that the flood fill cannot separate). 26 pictures:
Keychron Q0 / Q2 / Q4 / Q6 / Q12 / K4 / K6 / K8 / K10 HE and Lemokey L1 / P2 / P3 HE (every id of every ISO / JIS variant on the picture; the Q3 / Q5 / P1 variants
come from `aliases.json`), Redragon K556 / K580 / K617 / K618 / K673 / K686 / K707 HE and M61, Epomaker HE30, and Royal Kludge C68 / C84 / C87 / C96 / C98.
Keychron: all 35 firmware variants have a picture. Redragon, Epomaker: found by the name the panel reads from the product code (`src/lib/x68he-layout.ts`
`identityFor`), never by id (`2E3C:C365..C368` and `0416:7372` are shared by hundreds of boards), so the Devices home, which only has the USB name, draws those from
their layout until the panel is opened. Drawn from the layout instead (no official top view that cuts cleanly, or no Hall-effect product in the store): Womier M68HE PRO
(the store picture carries a light bar and a table edge), Epomaker HE60 Lite, Redragon K552 / K701 / K721 / M68 / M82 / RS82, Royal Kludge C61 / X87 / M75 HE, every AULA
SparkLink board (the maker's list has no model names) and Kochi.

Product images are (c) their respective owners. Want one removed? Open an issue.

## Fifth pass (game controllers)

`tools/vendors/pads.py` lists the controllers of `docs/devices/CONTROLLERS.md` with the makers' own sources: playstation.com renders (Sony's Scene7
server, `$facebook$` is a transparent PNG), Microsoft's image server behind microsoft.com/store (`fmt=png-alpha`), xbox.com, nintendo.com, the Steam
store and steamdeck.com, the Shopify stores of 8BitDo and Flydigi, and the product pages of GameSir (`/products/<handle>/buy`), SCUF (product and
category pages), Turtle Beach (which also sells PDP / Victrix), Razer, Thrustmaster, PowerA, Nacon, Logitech G and Corsair. `tools/sitemap_find.py`
finds a maker's product pages from its sitemaps and `tools/img_probe.py` lists the picture addresses a page uses. Pictures are cut with the matting
model (`cands2.py pads`, `build2.py pads`, the `isnet-general-use` rembg venv), picks in `picks/pads.json`, then `assemble2.py` (which now writes to
the checkout it runs from, so a worktree is safe). A job may carry `crop` (one product out of a group shot: the Joy-Con (L) and (R) are the halves of
Nintendo's pair render) or `bridge` (keep a product photographed in two pieces whole: the pair for the charging grip). The kind is `gamepad`.
USB ids are only on a picture when CONTROLLERS.md has them for that model alone: the Xbox 360-class `045E:028E` and `045E:02FF` (shared by many
pads), the Flydigi `04B4:2412` (two models) and every UNVERIFIED id are left off, so those pads are found by name. Discontinued pads come from the
Wayback Machine's copy of the maker's page (`vendors/padswb.py`, rows in `tools/padswb-rows.json`, the same method as `wayback3.py`).

## Sixth pass (lamps)

`tools/vendors/lights.py` lists the lamps of `docs/devices/LIGHTING.md` with the makers' own store pages (Govee: us.govee.com, where the
H6076 is sold as the "RGBICW Smart Corner Floor Lamp Basic"). The kind is `light`, and lamps are found by the model in their Bluetooth
name, never by USB id. Govee shoots its lamps lit, with the glow as part of the picture: such a job carries `soft` (the maker's alpha is kept
whole, no largest-piece cut, `proc2.py`) and `feather` (the glow fades out over that fraction of each side instead of ending at the crop,
`build2.py`), plus a `crop` that keeps the lamp and leaves the box and the phone beside it. `cands2.py lights`, picks in `picks/lights.json`,
`build2.py lights`, then `assemble2.py` (whose "also used for" note is now added once, not again on every run).
Wave L2 adds the other Govee models the US store still sells (`govee(...)` rows): their pictures are Govee's
box-and-app product shots, kept whole on the maker's transparency (`SOFT`); models no store sells any more get a drawing.

The Govee photo pass (`tools/vendors/goveewb.py`) covers the models Govee no longer sells, and the ones its store still
sells under pictures not named after the SKU: the gallery of Govee's own product page, today's where the page still
answers, else the Wayback Machine's copy of it (`us.govee.com/products/<handle>`, the same method as `padswb.py`). The
archive's CDX index answered 503 that day, so the rows (`tools/goveewb-rows.json`) carry each page's snapshot and the
gallery addresses read from it; those are Shopify CDN addresses that still answer live (`live_ok`), with the archived
copy as the fallback (`wb_ok`). One picture serves the other lengths of the same light (`aliases.json`). Shots are kept
whole (`soft`: light bars and strips are more than one piece) except `SOLID` ones; `cands2.py goveewb`, picks in
`picks/goveewb.json`, `build2.py goveewb`, `assemble2.py`. The Glide Triangle (H6067) stays drawn: its gallery has only
room scenes, which rembg cuts into outlines. LIGHTING.md §3a lists every model that stays drawn and what it is drawn as.
Kit shots (box, phone and light together) are cropped to the light (`CROP` per job), a cut strip fading out where the crop
cuts it (`GLOW`); a light the box hides part of stays drawn (the H605C and H6088).

The Wi-Fi lights of wave L3 (`tools/vendors/wifilights.py`): Philips Hue and WiZ renders from Signify's image server, asked
for as transparent PNGs (`fmt=png-alpha`); Nanoleaf's and Elgato's product pages; Twinkly's own CDN. LIFX's store answers
429 to scripted requests and its archived gallery has only packaging, so LIFX stays drawn.

## Controllers, wave 2

The named pads that still fell back to a drawing, the current and popular ones first (a script over `PAD_ROWS` and `photoKeyFor`
lists every named controller id without a picture): the first 8BitDo Ultimate (one family picture for its Bluetooth and 2.4G models
and their X-input ids) and its wired Xbox model, the HyperX Clutch Gladiate, Gladiate RGB and Tanto, the SteelSeries Stratus Duo, the
Razer Wolverine Ultimate and Kitsune, the ASUS ROG Raikiri and Raikiri Pro (rog.asus.com gallery pictures, `dlcdnwebimgs.asus.com/gain/<id>/w2000`),
the Nacon Pro Compact, the Nintendo Switch 2 Pro Controller, Joy-Con 2 and the Switch 2 GameCube controller (the My Nintendo Store's
renders, `f_png` on Nintendo's image server) and Turtle Beach's five Switch 2 pads (the Rematch and Afterglow wireless pads share
`0E6F:0193`, so those two are found by name). Same steps as the fifth pass, rows at the end of `vendors/pads.py`. `cands2.py pads <keys>`
now reads only the rows asked for, and `shop()` falls back to the store's public `/products.json` listing when a Shopify store answers
429 to `/products/<handle>.js` (hyperx.com and shop.8bitdo.com do after a few requests). Still drawn: the long tail of older pads
(PDP Xbox 360 colours, PS2/PS3 adapters, arcade sticks) and the ones whose maker no longer shows them (the original Xbox Elite, the
Stadia and Luna controllers, the Flydigi Vader 4 / Apex 4 that share one id).
## Headsets

`tools/vendors/headsets.py` lists the headsets SYNQ drives (src/lib/headsets/headsets.json) with the makers' own sources:
steelseries.com product pages (Contentful renders), logitechg.com product pages (gallery renders on resource.logitechg.com) and
HyperX's Shopify store. Same steps as the fifth pass: `cands2.py headsets` (review sheets), picks in `picks/headsets.json`,
`build2.py headsets`, `assemble2.py`, then `node scripts/gen-device-images.mjs`. The kind is `headset`. 8 pictures: Arctis Nova 7,
7X, 7 Diablo IV, 7 WoW Edition and Nova 7 Wireless Gen 2, Logitech G535, PRO X 2 and G733. HyperX's store answered 429 (rate
limited) on 2026-10-16, so the Cloud II Wireless is drawn until a later pass; the PRO X Wireless and the G633 / G933 / G935 pages are
gone from logitechg.com.

## Monitors and webcams

`tools/vendors/displays.py`, the same steps (`cands2.py displays`, `picks/displays.json`, `build2.py displays`, `assemble2.py`). Kinds
`monitor` and `webcam`. Monitors have no USB ids: the picture is found by the name their EDID gives ("VG248"), so the
ASUS VG248QE picture (asus.com) also stands for EDID name "VG248". Webcams by USB id: Logitech C920 (the C920s gallery,
same shell), C922 and BRIO (logitech.com, logitechg.com).

## Monitor and webcam wave 2

The popular gaming monitors and webcams, same file and steps (rows after the first four in `tools/vendors/displays.py`; `cands2.py
displays <keys>` reads only the rows asked for). 44 more pictures, each picked by eye from the review sheets:

- Monitors (by the model in the EDID name, and only for that maker): ASUS ROG PG27AQDM, PG32UCDM, PG27AQN, XG27AQM (rog.asus.com
  galleries) and TUF VG27AQ, VG259QM, VG279QM (asus.com); LG UltraGear 27GR95QE, 27GP850, 32GS95UE, 27GS95QE (lg.com); Samsung
  Odyssey OLED G9 (also G93SD/G91SD/G95SC/G93SC, one shell), OLED G8 34" (G85SD/G85SB), OLED G8 27" (G81SF), G9 G95C, Neo G9 57"
  (G95NC), Neo G8 (G85NB), Neo G7 32" (G75NB) and G7 G70D (samsung.com); ZOWIE XL2546K (also the XL2566K, the same shell, and
  "ZOWIE XL LCD", what most XL EDIDs say), XL2540K and XL2586X (zowie.benq.com); AOC 24G2 (the 24G2U page: the same shell with a USB
  hub; the US 24G2 address is a listing), 27G2 and AGON PRO AG276QZD (aoc.com).
- Webcams: Logitech MX Brio, StreamCam, C270, C310, C615, C925e and Brio 500 (also the 501 and 505) on logitech.com; Razer Kiyo,
  Kiyo Pro, Kiyo X and Kiyo Pro Ultra (razer.com: the Kiyo X store page's gallery, the product pages' renders for the rest); Elgato
  Facecam, Facecam MK.2, Facecam Pro and Facecam Neo (elgato.com); OBSBOT Tiny 2; Insta360 Link and Link 2; Anker PowerConf C200
  (anker.com). USB ids only where certain (Logitech C270 `046D:0825`, C310 `081B`, C615 `082C`, C925e `085B`, StreamCam `0893`;
  Razer Kiyo `1532:0E03`, Kiyo Pro `0E05`); the others are found by the name the camera reports.

Several image servers serve pictures without a file extension (ROG's `gain` ids, LG's transform paths, BenQ's and Samsung's Scene7
names, Elgato's Cloudinary paths, AOC's Sanity ids), so those rows use an `ids` source: a regex for the picture id on the page and
the address that serves it. Samsung's PNG preset is already cut out, except on the G9 G95C, Neo G9 57" and G70D, where it keeps a
white ground; those take the JPEG preset and go through rembg. An EDID maker code ("AOC", "DEL") is never read as a USB id.

Still drawn, with the reason (most of the Dell, MSI, Gigabyte and LifeCam models now have pictures from the makers'
archived pages, next section):

- Alienware AW2725DF, AW3423DWF, AW2523HF, AW2724HF and Dell S2721DGF, G2724D: dell.com answers 403 to the pipeline.
- MSI MAG 271QPX, MPG 321URX, MAG 274QRF (msi.com) and Gigabyte M27Q, FO27Q3 (gigabyte.com): 403 as well.
- Samsung's 2020 curved Odyssey G7 (C27G75T / C32G75T) and the first white Odyssey G9: their pages are gone from samsung.com. A
  Samsung whose EDID says only "Odyssey G7" or "Odyssey G9" stays drawn too, since each name covers several shells.
- An LG whose EDID says only "LG ULTRAGEAR".
- Microsoft LifeCam HD-3000 and LifeCam Studio: microsoft.com's accessory pages answer 404.
- OBSBOT Meet 2: the page shows it only in pairs, and none of its other pictures cut out cleanly.
- Insta360 Link 2C: the page has it only next to the Link 2, in 272 px thumbnails. "2C" counts as a variant word, so a Link 2C never
  borrows the Link's picture.

The fallback drawings for both kinds were redrawn to the controller drawing's level of detail: the monitor with its panel, glint,
chin, neck and foot; the webcam with its lens, mics, status light, hinge and the clip over a screen's edge.

## Monitors and webcams from archived pages

The models whose makers refused the pipeline (dell.com, msi.com and gigabyte.com answer 403) or dropped the page
(Microsoft's LifeCams, 404): `tools/vendors/displayswb.py` takes each maker's own product page as the Wayback Machine kept
it and the pictures it linked, from the maker's image server when it still answers (msi.com's `asset.msi.com` and
gigabyte.com's `static.gigabyte.com` do) or else the archive's copy (`wb:<timestamp>:<url>`), the same method as
`wayback3.py` and `padswb.py`. The image servers name pictures without a picture extension (Dell's Scene7 `.psd` names,
Gigabyte's `/png/1000` paths), so each row has its own address regex. Dell's archived captures sit under suffixed
addresses (`…/apd/210-bfed/0`), so its rows read every capture under the product page (`*`). Microsoft's 2015–2017 pages
redirect to the webcam listing, so each LifeCam row takes only pictures named for its model (`ic_lcstv2_*` Studio,
`ic_hd3000*` HD-3000). The archive throttles, so each model's candidate list is kept in `tools/displayswb-urls.json` once
made: the sheets, `picks/displayswb.json` and `build2.py displayswb` always see the same list.

11 pictures, picked by eye: Alienware AW2725DF, AW3423DWF, AW2523HF, AW2724HF; MSI MAG 271QPX QD-OLED, MPG 321URX QD-OLED,
MAG 274QRF-QD; Gigabyte M27Q, AORUS FO27Q3; Microsoft LifeCam Studio (`045E:0772`) and HD-3000. Still drawn: the Dell
S2721DGF (no archived capture of its page holds a picture) and the Dell G2724D (its archived gallery has only side, top and
underside views). Regional sites didn't help: dell.com answers 403 on every region, and the LifeCam pages are gone from all.

## RGB hubs

`tools/vendors/hubs.py`, kind `light` (the Lights group), by USB id: the Corsair Lighting Node Pro (`1B1C:0C0B`) and the
Nautilus RS LCD screen module, which reports itself as the CORSAIR Nautilus LCD Cap (`1B1C:0C57`), from corsair.com
galleries. Still drawn: the NZXT hubs (nzxt.com answered 429), the Lian Li Uni Hub SL (its page has only a line drawing of
the controller), the other Corsair Lighting Node models (no page with the hub alone).
