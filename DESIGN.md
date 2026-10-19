---
name: SYNQ
description: Every device. One system.
colors:
  synq-orange: "#ff5e3a"
  orange-ink: "oklch(99% 0.006 45)"
  room: "oklch(17% 0.004 50)"
  type: "oklch(97% 0.004 60)"
  type-quiet: "oklch(73% 0.006 60)"
  card: "oklch(21.5% 0.004 50)"
  popover: "oklch(22.5% 0.004 50)"
  muted: "oklch(27% 0.004 50)"
  tile-top: "oklch(34% 0.005 55)"
  tile-bottom: "oklch(29.5% 0.005 55)"
  panel-top: "oklch(26% 0.008 40)"
  panel-bottom: "oklch(21.5% 0.005 50)"
  live: "oklch(79% 0.2 147)"
  asleep: "oklch(65% 0.004 60)"
  cut-grey: "oklch(87% 0.004 60)"
  destructive: "#ff5d6c"
typography:
  display:
    fontFamily: "Helvetica, Nimbus Sans, Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(64px, 7.2vw, 128px)"
    fontWeight: 700
    lineHeight: 0.86
    letterSpacing: "-0.055em"
  headline:
    fontFamily: "Helvetica, Nimbus Sans, Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(36px, 3.4vw, 50px)"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.045em"
  number:
    fontFamily: "Helvetica, Nimbus Sans, Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "52px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Helvetica, Nimbus Sans, Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Helvetica, Nimbus Sans, Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "-0.01em"
  label:
    fontFamily: "Helvetica, Nimbus Sans, Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.16em"
  mono:
    fontFamily: "DM Mono, ui-monospace, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0"
rounded:
  tight: "6px"
  small: "8px"
  control: "10px"
  popover: "14px"
  card: "18px"
  pill: "9999px"
spacing:
  gutter: "clamp(28px, 3.2vw, 56px)"
  page-x: "32px"
  card-x: "28px"
  dock-gap: "24px"
components:
  button-primary:
    backgroundColor: "{colors.type}"
    textColor: "{colors.room}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 20px"
  button-quiet:
    backgroundColor: "rgb(255 255 255 / 0.06)"
    textColor: "{colors.type}"
    rounded: "{rounded.control}"
    height: "50px"
  tab-selected:
    backgroundColor: "{colors.type}"
    textColor: "{colors.room}"
    rounded: "{rounded.pill}"
    height: "36px"
    padding: "0 18px"
  device-tile:
    backgroundColor: "{colors.tile-top}"
    textColor: "{colors.type}"
    rounded: "{rounded.card}"
  panel:
    backgroundColor: "{colors.panel-top}"
    textColor: "{colors.type}"
    rounded: "{rounded.card}"
  switch-on:
    backgroundColor: "{colors.synq-orange}"
    rounded: "{rounded.pill}"
    width: "38px"
    height: "22px"
---

# Design System: SYNQ

## 1. Overview

**Creative North Star: "Every device. One system."**

SYNQ is one quiet room where all of someone's gear lives together: a mouse, a keyboard, headphones, a controller, lamps and monitors, each from a different maker, each shown as the real product on its own lit grey tile. The room is dark and warm, never blue. One colour, SYNQ orange, marks what is active: the device in use, the control being changed, the running EQ, the selected tab. Everything else is warm neutral and white type in Helvetica, set big and tight where it names things ("Your setup.") and small and plain where it explains them.

Depth comes from light, not from boxes. Devices sit on lit tiles; the active device's controls sit on frosted glass over a slab of live orange light; the window itself is a dim dot display with a few embers drifting through it. That live light (Paper Shaders, drawn in a worker at 12 frames a second, still whenever SYNQ isn't the focused window) is the one flourish, and it costs next to nothing. Motion is calm and exact: springs that settle without wobbling, exponential ease-outs, transforms only.

It rejects the things the person already turned down: generic AI glow (blurry colour orbs, purple gradients, everything glowing), the settings spreadsheet (endless rows of toggles with no hierarchy), a generic sidebar settings app or anything violet, and the paper spec sheet or staged desk scene.

**Key Characteristics:**
- Real product photos on lit grey tiles; the page names them, it doesn't decorate them.
- One accent, SYNQ orange (#ff5e3a), on what is active, never as decoration.
- Warm neutrals only (OKLCH hue 40 to 60, chroma 0.004 to 0.008).
- Huge tight headlines, plain small body copy, label caps for section names.
- Glass only where light sits behind it (the active card, the dock); live light only where it means something.
- Status is always a dot and words: green for connected, grey for asleep.

## 2. Colors

A warm near-black room with one orange voice and a green that only ever means "connected".

### Primary
- **SYNQ Orange** (#ff5e3a): the active device's corner tick and slab, the selected dock icon, a switch that is on, the DPI ring, slider fills, a running EQ curve, the "EQ active" badge. Text on it is Orange Ink (oklch(99% 0.006 45)).

### Neutral
- **Room** (oklch(17% 0.004 50)): the window. The backdrop shader's darkest tones are set to match it.
- **Type** (oklch(97% 0.004 60)): headlines, values, primary buttons (white, with Room text).
- **Quiet Type** (oklch(73% 0.006 60)): explanations, labels under values, captions.
- **Tile Light** (oklch(34% 0.005 55) to oklch(29.5% 0.005 55)): the device tiles, lit from above.
- **Panel** (oklch(26% 0.008 40) to oklch(21.5% 0.005 50)): settings panels, sheets, the status strip; darker than a tile, warm at the top-left.
- **Popover** (oklch(22.5% 0.004 50)): menus and listboxes.
- **Hairline** (rgb(255 255 255 / 0.08 to 0.14)): borders, dividers, tile edges.

### Status
- **Live** (oklch(79% 0.2 147)): connected, reached, in range. Only as a dot, always with words.
- **Asleep** (oklch(65% 0.004 60)): asleep, not reached, off.
- **Destructive** (#ff5d6c): failed writes and real errors only.

### Named Rules
**The One Voice Rule.** Orange marks what is active and nothing else: under 10% of any screen outside the active card's slab. No orange headings, no orange decoration, no second accent.

**The Warm Room Rule.** No neutral is ever cool. No #000, no #fff, no blue-black (#0c0c0f-style) surfaces; every grey leans toward the orange.

**The Dot And Words Rule.** Colour is never the only signal. Every status dot has its words beside it.

## 3. Typography

**Display Font:** Helvetica where the computer has it, otherwise Nimbus Sans (URW++'s Helvetica, bundled, AGPL); Geist Variable as the last fallback
**Body Font:** the same
**Label/Mono Font:** DM Mono for technical text (USB ids, logs)

**Character:** Helvetica, in two weights, regular and bold, so it reads the same on every machine (real Helvetica and Nimbus Sans each ship those two): hierarchy is scale first, then the jump from regular to bold. A 128 px bold headline beside 14 px plain copy. Tight negative tracking on big type, wide tracking on small caps.

### Hierarchy
- **Display** (700, clamp(64px, 7.2vw, 128px), 0.86, -0.055em): the section homes ("Your setup.", "Your lights.").
- **Headline** (700, clamp(36px, 3.4vw, 50px), 1, -0.045em): a device page's name; the welcome's promise at up to 60 px.
- **Number** (700, 52 px, -0.04em, tabular): the active card's big value; the DPI dial goes to 92 px.
- **Title** (600 to 700, 24 to 30 px, -0.03em): device names on tiles and the active card.
- **Body** (400, 13.5 to 15 px, 1.55): explanations, capped near 65ch.
- **Label** (600, 11 px, 0.16em, uppercase, white at 70%): section names ("ACTIVE DEVICE", "CURRENT STATUS", a tile's kind).

### Named Rules
**The Say It Plainly Rule.** Device names and real numbers, no marketing words, no exclamation marks, no em dashes. "Not read yet", never a made-up value.

## 4. Elevation

Depth is light, in three layers: lit tiles (a top-to-bottom gradient with a 1 px light edge and an inset highlight), panels (a darker warm gradient), and glass (frosted, over something lit). Shadows are soft and long, never harsh, and are the shadow of something real (the orange slab's glow, a tile lifting, a popover).

### Shadow Vocabulary
- **Tile** (`inset 0 1px 0 rgb(255 255 255 / 0.06), 0 24px 48px -28px rgb(0 0 0 / 0.7)` with a 1 px `rgb(255 255 255 / 0.12)` edge): device tiles and device page heroes.
- **Panel** (`inset 0 1px 0 rgb(255 255 255 / 0.05), 0 30px 60px -32px rgb(0 0 0 / 0.8)` with a 1 px `rgb(255 255 255 / 0.09)` edge): settings panels, sheets, the status strip.
- **Glass** (`inset 0 1px 0 rgb(255 255 255 / 0.16), inset 0 -1px 0 rgb(0 0 0 / 0.3), 0 34px 70px -34px rgb(0 0 0 / 0.9)` with `backdrop-filter: blur(30px) saturate(165%)`): the active card and the dock.
- **Slab Glow** (`0 30px 90px -30px rgb(255 94 58 / 0.55)`): only under the active card's orange slab.
- **Popover** (`0 24px 48px rgb(0 0 0 / 0.6)`): menus and listboxes.

### Named Rules
**The Glass Over Light Rule.** Glass appears only where something lit sits behind it: the active card over the live orange slab, the dock over the tiles. Never a glass card on a flat background.

**The Concentric Corners Rule.** A rounded thing inside a rounded thing shares its centre: outer radius = inner radius + the gap between them. Corners come by role (src/index.css): 18 px for a tile, panel or sheet, 14 px for a menu or toast, 10 px for a button, input, well or box 36 px tall and up, 8 px under that, 6 px for badges and tiny inputs. Where something sits closer to an edge than its outer corner, the formula wins: the command menu is 18 px around 12 px rows with 6 px padding, a menu 14 px around 8 px rows, a button 10 px around a 4 px chip 6 px in, a tile's 17 px corner tick inside its 18 px corner and 1 px edge. The dock keeps its own 22 px around 14 px items with 8 px padding. Pills are for chips, tabs, toggles, status tags and the dock, never for buttons; pills in pill tracks are round on both, which always fits.

**The Even Line Rule.** Icons are Phosphor on one scale: 12, 14, 16, 20 and 24 px (10 for a glyph in a tiny badge; illustrations 28 and up). The weight follows the size so every line is about 1 px: regular up to 14, light from 16 to 24; the big illustrations (28 and up) are drawn light or thin. Bold only for a glyph of 10 and for small icons on a solid white or orange fill (one step heavier there); fill for state (on, playing, done). In a line of text the icon goes one step under the text: 12 beside 11.5 to 13 px, 14 beside 13.5 to 15.

**The Live Light Rule.** Shaders (src/components/ui/shader.tsx) are the window backdrop, the active card's slab and the welcome, nothing else. They draw in one worker at 12 fps, move only while SYNQ is focused and visible, and hold still with reduced motion.

## 5. Components

### Buttons
- **Shape:** 10 px rounded rectangles (8 px under 36 px tall); an arrow or bolt chip inside one is 4 px, 6 px in.
- **Primary:** white (Type) with Room text, 40 px tall, 20 px sides.
- **Quiet:** white at 6% with a white 10% ring; hover to 10%; press scales to 0.99.
- **Outlined:** "Run a checkup ↗": a 10 px rounded outline, white at 14%.

### Device Tile (signature)
- **Corner Style:** 18 px.
- **Background:** Tile Light gradient, hairline edge, the real product photo with a soft drop shadow.
- **Content:** label caps kind, the name at 24 px bold, a status dot with words. The active device's tile carries the orange corner tick (62 px, 30 px bottom-left radius) and a brighter edge.

### Active Card (signature)
- A glass card over a slab of live orange light (the grain shader), offset 36 px left and 24 px up behind it. The device picker (a chevron listbox), the big number with an orange slider when the device can be set from here, two stats between hairlines, and "Configure device". The light on the glass follows the pointer (src/components/ui/glass.tsx).

### Cards / Containers
- **Panel:** 18 px corners, the Panel gradient, 20 to 28 px padding. Stats sit side by side between hairlines inside one panel, never as a row of identical boxes.

### Inputs / Fields
- **Switch:** 38 × 22 px pill, orange when on; the thumb stretches while held and lands on a spring (src/components/ui/switch.tsx).
- **Slider:** a thin track filled orange up to the value, a glowing orange thumb; changes commit on release and go through the device's guarded session.
- **Focus:** a 2 px outline in orange lifted toward white, 2 px offset.

### Navigation
- **Dock:** a glass bar at the bottom: Gear, Lights, Displays, Games, Helper, then Settings after a divider. The current section is a lit square (white at 11%) with its icon filled in orange. It centres under the tile grid on wide windows.
- **Tabs:** a pill track; the selected tab is a white pill that slides to the next one, and a faint highlight glides under the pointer.
- **Back:** "‹ Gear" as a 10 px glass button at the top-left of every device page.

## 6. Do's and Don'ts

### Do:
- **Do** show the real product photo of every supported device on a lit tile.
- **Do** keep orange (#ff5e3a) for what is active: the device in use, its controls, a running EQ, the selected dock entry.
- **Do** pair every status dot with words: "Wireless · Connected · 75%".
- **Do** lead each screen with the one or two things people come to change, then group the rest into a few named sections.
- **Do** say what a change does, that it's saved on the device and that it can be undone, right where the change happens.
- **Do** set type in Helvetica (Nimbus Sans where it isn't installed), regular or bold; never bundle Helvetica's own files, which are licensed.
- **Do** move things by transform and opacity with exponential ease-outs or critically damped springs, and honour reduced motion.

### Don't:
- **Don't** use generic AI glow: blurry colour orbs, purple gradients, everything glowing.
- **Don't** build the settings spreadsheet: endless rows of toggles and dropdowns with no hierarchy.
- **Don't** build a generic sidebar settings app, and don't use violet anywhere.
- **Don't** style anything as a paper spec sheet or a staged desk scene.
- **Don't** put glass on a flat background, or a glow behind a small dot.
- **Don't** repeat the hero-metric template: a row of identical boxes with a big number and a small label.
- **Don't** use gradient text, side-stripe borders, #000, #fff, or cool blue-blacks.
- **Don't** write em dashes, exclamation marks, or values SYNQ didn't read from the device.
