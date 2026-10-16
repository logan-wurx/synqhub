"""SYNQ's brand files, made from the logo pack in source/ (PNGs with real transparency) and the SVGs traced from it
(svg/, by trace.py). Needs Python 3 with Pillow. Run from the repo root:

    python branding/synq/build.py
    npx tauri icon branding/synq/app-icon-1024.png -o src-tauri/icons

The brand colour is the sunset orange of the app's room light (#FF5E3A), not the pack's violet: the pack's app icon is
recoloured from violet to it, and every tile and panel below is orange.

It writes:
- branding/synq/app-icon-1024.png      the app icon (the pack's, in orange), which `tauri icon` turns into icon.ico/.icns/PNGs
- branding/synq/svg/mark-*.svg         the mark in white, black and orange; app-icon.svg (orange tile, white mark)
- src/components/ui/synq-logo.generated.ts   the mark's two links and the word as path data, for the app
- src-tauri/installer/header.bmp       the installer's page header, 150 x 57
- src-tauri/installer/sidebar.bmp      the installer's welcome and finish panel, 164 x 314
- public-web/favicon.svg, favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png   the website's icons
- public-web/og-image.png              the picture a shared link shows, 1200 x 630
- branding/synq/readme-banner.png      the top of the README, 1600 x 400
- branding/synq/social-preview.png     GitHub's repository preview, 1280 x 640
- branding/synq/pfp-1000.png           a profile picture for X and the like (cut to a circle there), 1000 x 1000
"""
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "branding" / "synq"
SRC = HERE / "source"
SVG = HERE / "svg"
WEB = ROOT / "public-web"
INSTALLER = ROOT / "src-tauri" / "installer"

PACK_VIOLET = (0x61, 0x49, 0xFD)  # the pack's tile colour (source/README.txt)
ORANGE = "#FF5E3A"  # SYNQ's colour: the room light's sunset (src/lib/lighting/glow.ts SUNSET[0])
ROOM = (7, 7, 8)  # the app's ground (#070708)


def rgb(hex_colour: str) -> tuple[int, int, int]:
    n = int(hex_colour[1:], 16)
    return (n >> 16) & 255, (n >> 8) & 255, n & 255


def recolour(im: Image.Image, to: str) -> Image.Image:
    """The pack's violet-and-white artwork in `to` and white: each pixel's mix of violet and white (its edges and the
    mark's anti-aliasing) is kept, only the violet changes. Transparency stays as it is."""
    src, dst = PACK_VIOLET, rgb(to)
    res = im.copy()
    px = res.load()
    for y in range(res.height):
        for x in range(res.width):
            r, g, b, a = px[x, y]
            # How far towards white the pixel is, from the two channels violet and white differ most in.
            t = min(1.0, max(0.0, ((r - src[0]) / (255 - src[0]) + (g - src[1]) / (255 - src[1])) / 2))
            px[x, y] = tuple(round(c + (255 - c) * t) for c in dst) + (a,)
    return res


def png(name: str) -> Image.Image:
    im = Image.open(SRC / name).convert("RGBA")
    return im.crop(im.getbbox())


def fit(im: Image.Image, w: int, h: int) -> Image.Image:
    """Scaled to fit inside w x h, keeping its shape."""
    s = min(w / im.width, h / im.height)
    return im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)


def place(canvas: Image.Image, im: Image.Image, cx: float, cy: float) -> None:
    canvas.alpha_composite(im, (round(cx - im.width / 2), round(cy - im.height / 2)))


def tagline(white: bool) -> Image.Image:
    """The tagline alone: the lower band of the tagline lockup."""
    im = Image.open(SRC / f"synq-logo-tagline-{'white' if white else 'black'}.png").convert("RGBA")
    band = im.crop((0, 760, im.width, im.height))
    return band.crop(band.getbbox())


def mark_paths() -> tuple[str, str]:
    """The traced mark's two links (upper-left, lower-right), as separate path data."""
    d = re.search(r' d="([^"]+)"', (SVG / "mark.svg").read_text()).group(1)
    links = [p + "Z" for p in d.split("Z") if p.strip()]
    left = lambda p: min(float(x) for x in re.findall(r"([\d.]+) [\d.]+", p))
    links.sort(key=left)
    return links[0], links[1]


def write_app_paths() -> None:
    """The mark and the word as path data for the app (src/components/ui/brand.tsx draws them, the second link in the
    accent)."""
    a, b = mark_paths()
    word = re.search(r' d="([^"]+)"', (SVG / "wordmark.svg").read_text())
    box = re.search(r'viewBox="([^"]+)"', (SVG / "wordmark.svg").read_text()).group(1)
    out = ROOT / "src" / "components" / "ui" / "synq-logo.generated.ts"
    out.write_text(
        "// Written by branding/synq/build.py from the logo pack (branding/synq/source); don't edit by hand.\n"
        '/** The mark: two links, upper-left then lower-right, in a 800 x 786 box. */\n'
        'export const MARK_VIEWBOX = "0 0 800 786";\n'
        f'export const MARK_LINKS = ["{a}", "{b}"] as const;\n'
        "/** The word \"synq\" from the logo. */\n"
        f'export const WORDMARK_VIEWBOX = "{box}";\n'
        f'export const WORDMARK = "{word.group(1)}";\n',
        newline="\n",
    )


def write_svgs() -> None:
    a, b = mark_paths()
    box = 'viewBox="0 0 800 786"'
    for name, colour in [("white", "#FFFFFF"), ("black", "#000000"), ("orange", ORANGE)]:
        (SVG / f"mark-{name}.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" {box}><path fill="{colour}" d="{a}{b}"/></svg>\n')
    # The app icon as a vector: the pack's tile (rounded square) in orange with the mark in white at the pack's scale.
    tile = f'<rect width="1024" height="1024" rx="228" fill="{ORANGE}"/><g transform="translate(192 200) scale(0.8)"><path fill="#FFFFFF" d="{a}{b}"/></g>'
    (SVG / "app-icon.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{tile}</svg>\n')
    (WEB / "favicon.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{tile}</svg>\n')


def write_icons() -> None:
    icon = recolour(Image.open(SRC / "synq-app-icon.png").convert("RGBA"), ORANGE)
    icon.save(HERE / "app-icon-1024.png")
    icon.save(WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    for size in (192, 512):
        icon.resize((size, size), Image.LANCZOS).save(WEB / f"icon-{size}.png")
    # Apple rounds the corners itself: a full square of orange, the mark on it.
    touch = Image.new("RGBA", (180, 180), ORANGE)
    place(touch, fit(png("synq-icon-white.png"), 112, 112), 90, 90)
    touch.convert("RGB").save(WEB / "apple-touch-icon.png")


def lockup_card(w: int, h: int, logo_w: float) -> Image.Image:
    """Logo and tagline, white, centred on the app's ground."""
    card = Image.new("RGBA", (w, h), ROOM + (255,))
    logo = fit(png("synq-logo-white.png"), logo_w, h * 0.5)
    line = fit(tagline(True), logo.width * 0.7, h * 0.12)
    gap = h * 0.07
    top = (h - logo.height - gap - line.height) / 2
    place(card, logo, w / 2, top + logo.height / 2)
    place(card, line, w / 2, top + logo.height + gap + line.height / 2)
    return card


def write_installer() -> None:
    # The header sits on the installer's white page band.
    header = Image.new("RGBA", (150, 57), (255, 255, 255, 255))
    place(header, fit(png("synq-logo-black.png"), 120, 30), 75, 28.5)
    header.convert("RGB").save(INSTALLER / "header.bmp")
    # The welcome and finish panel: orange, the mark, the word and the line under it.
    side = Image.new("RGBA", (164, 314), ORANGE)
    place(side, fit(png("synq-icon-white.png"), 84, 84), 82, 104)
    place(side, fit(png("synq-wordmark-white.png"), 96, 40), 82, 182)
    place(side, fit(tagline(True), 136, 14), 82, 216)
    side.convert("RGB").save(INSTALLER / "sidebar.bmp")


def write_pfp() -> None:
    """A profile picture (X, Discord, ...): a full square of orange with the mark in white, small enough that the
    circle those sites cut stays clear of it. 1000 x 1000, which they scale down."""
    pfp = Image.new("RGBA", (1000, 1000), ORANGE)
    place(pfp, fit(png("synq-icon-white.png"), 560, 560), 500, 500)
    pfp.convert("RGB").save(HERE / "pfp-1000.png")


def main() -> None:
    write_svgs()
    write_pfp()
    write_app_paths()
    write_icons()
    write_installer()
    lockup_card(1200, 630, 760).convert("RGB").save(WEB / "og-image.png")
    lockup_card(1600, 400, 980).convert("RGB").save(HERE / "readme-banner.png")
    lockup_card(1280, 640, 820).convert("RGB").save(HERE / "social-preview.png")
    print("SYNQ brand files written.")


if __name__ == "__main__":
    main()
