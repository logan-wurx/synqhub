"""Logitech G HUB depot device images (official updates.ghub.logitechg.com, read with HTTP Range): mice + G keyboards.
(key, name, kind, ids, extra names, depot file)"""
import json
from common import ROOT, job
RAW = ROOT / "raw" / "logitech"
V = 0x046d
def i(*pids): return [f"046d:{p:04x}" for p in pids]
ROWS = [
    ("logitech-g203", "G203 LIGHTSYNC", "mouse", i(0xc092, 0xc084, 0xc089), ["g102", "g102 lightsync", "g203 prodigy", "g203 lightsync", "g203"], "g102_g203__g203_lightsync.png"),
    ("logitech-g302", "G302 Daedalus Prime", "mouse", [], ["g302"], "g302__g302.png"),
    ("logitech-g303", "G303 Daedalus Apex", "mouse", i(0xc080), ["g303", "g303 daedalus apex", "g303 shroud edition"], "g303__g303.png"),
    ("logitech-g305", "G305 LIGHTSPEED", "mouse", [], ["g305", "g304", "g305 lightspeed"], "g305__g305.png"),
    ("logitech-g402", "G402 Hyperion Fury", "mouse", i(0xc07e), ["g402"], "g402__g402.png"),
    ("logitech-g403-hero", "G403 HERO", "mouse", i(0xc08f), ["g403", "g403 hero"], "g403_hero__g403_hero.png"),
    ("logitech-g403-lightspeed", "G403 Prodigy Wireless", "mouse", [], ["g403 wireless", "g403 prodigy"], "g403__g403_wireless.png"),
    ("logitech-g502-hero", "G502 HERO", "mouse", i(0xc08b), ["g502", "g502 hero", "g502 hero se"], "g502_hero__g502_hero.png"),
    ("logitech-g502-proteus", "G502 Proteus Spectrum", "mouse", i(0xc07d), ["g502 proteus", "g502 proteus spectrum", "g502 spectrum"], "g502__g502_spectrum.png"),
    ("logitech-g502-lightspeed", "G502 LIGHTSPEED", "mouse", [], ["g502 lightspeed", "g502 wireless"], "g502_wireless__g502_wireless.png"),
    ("logitech-g600", "G600", "mouse", [], ["g600"], "g600__g600.webp"),
    ("logitech-g602", "G602", "mouse", [], ["g602"], "g602__g602.png"),
    ("logitech-g603", "G603 LIGHTSPEED", "mouse", [], ["g603"], "g603__g603.png"),
    ("logitech-g604", "G604 LIGHTSPEED", "mouse", [], ["g604"], "g604__g604.png"),
    ("logitech-g703", "G703 LIGHTSPEED", "mouse", [], ["g703", "g703 hero", "g703 lightspeed"], "g703_hero__g703_hero.png"),
    ("logitech-g900", "G900 Chaos Spectrum", "mouse", [], ["g900"], "g900__g900.png"),
    ("logitech-g903", "G903 LIGHTSPEED", "mouse", [], ["g903", "g903 hero", "g903 lightspeed"], "g903_hero__g903_hero.png"),
    ("logitech-g-pro", "G Pro (2017)", "mouse", i(0xc085), ["g pro", "pro gaming mouse", "g pro gaming mouse"], "pro_mouse__pro_mouse.png"),
    ("logitech-g-pro-hero", "G Pro HERO", "mouse", i(0xc08c), ["g pro hero", "pro hero"], "pro_mouse_hero__pro_mouse_hero.png"),
    ("logitech-g-pro-wireless", "G Pro Wireless", "mouse", i(0xc088), ["g pro wireless", "pro wireless"], "pro_wireless_mouse_depot__pro_wireless_mouse.png"),
    ("logitech-pro-x-superlight", "G PRO X SUPERLIGHT", "mouse", i(0xc094), ["pro x wireless", "pro x superlight", "g pro x superlight", "g pro x wireless"], "pro_x_wireless_mouse__pro_x_wireless_mouse.png"),
    ("logitech-mx518", "MX518 Legendary", "mouse", i(0xc08e), ["mx518"], "mx518__mx518.png"),
    # keyboards
    ("logitech-g213", "G213 Prodigy", "keyboard", i(0xc336), ["g213"], "g213_international_2__g213.png"),
    ("logitech-g413", "G413", "keyboard", [], ["g413"], "g413_international_2__g413.png"),
    ("logitech-g512", "G512 RGB", "keyboard", i(0xc33c), ["g512", "g512 carbon", "g512 se"], "g512_se_international_2__g512_se.png"),
    ("logitech-g513", "G513", "keyboard", [], ["g513"], "g513_international_2__g513.png"),
    ("logitech-g610", "G610 Orion", "keyboard", [], ["g610"], "g610_international_2__g610.png"),
    ("logitech-g613", "G613", "keyboard", [], ["g613"], "g613_international_2__g613.png"),
    ("logitech-g810", "G810 Orion Spectrum", "keyboard", [], ["g810"], "g810_international_2__g810.png"),
    ("logitech-g815", "G815 LIGHTSYNC", "keyboard", i(0xc33f), ["g815", "g813"], "g815_international_2__g815.png"),
    ("logitech-g910", "G910 Orion Spectrum", "keyboard", [], ["g910"], "g910_international_2__g910.png"),
    ("logitech-g915", "G915 LIGHTSPEED", "keyboard", i(0xc33e), ["g915", "g913"], "g915_international_2__g915.png"),
    ("logitech-g915-tkl", "G915 TKL LIGHTSPEED", "keyboard", i(0xc343), ["g915 tkl", "g913 tkl"], "g915_tkl_international_2__g915_tkl.png"),
    ("logitech-pro-keyboard", "PRO Mechanical Gaming Keyboard", "keyboard", i(0xc339), ["pro keyboard", "pro mechanical", "g pro keyboard"], "pro_keyboard_international_2__pro_keyboard.png"),
]
def jobs():
    idx = {r["file"]: r for r in json.load(open(RAW / "_index.json"))}
    out = []
    for key, name, kind, ids, names, f in ROWS:
        fp = RAW / f
        if not fp.exists(): print("missing", f); continue
        d = next(r for r in idx.values() if r["file"] == f)
        out.append(job(key, "logitech", name, kind, ids, file=str(fp), url=d["url"], names=[name] + names, note=f"G HUB depot {d['depot']} / {d['modelId']} ({d['src']})"))
    return out
