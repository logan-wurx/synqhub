"""OpenMouse's own device images (img.openmouse.app, the bucket behind openmouse.app / control.openmouse.app), mapped by model name and USB id.
OpenMouse sourced them from the makers' pages and configurators (see public/devices/README.md in OpenMouse-Project/openmouse)."""
from common import ROOT, job

RAW = ROOT / "raw" / "om"
BASE = "https://img.openmouse.app/"


def ids(vid, *pids):
    return [f"{vid}:{p:04x}" for p in pids]


R = "1532"
# key, vendor, name, ids, extra names, file
ROWS = [
    ("razer-deathadder-v2", "razer", "Razer DeathAdder V2", ids(R, 0x84, 0x7c, 0x7d), ["deathadder v2", "razer deathadder v2", "deathadder v2 pro", "razer deathadder v2 pro", "deathadder v2 pro wired"], "razer-deathadder-v2.png"),
    ("razer-viper-v2-pro", "razer", "Razer Viper V2 Pro", ids(R, 0xa5, 0xa6, 0xb3), ["viper v2 pro", "razer viper v2 pro", "viper v2 pro hyperpolling 8000 hz"], "razer-viper-v2-pro.png"),
    ("razer-viper-mini", "razer", "Razer Viper Mini", ids(R, 0x8a, 0x9e, 0x9f), ["viper mini", "razer viper mini", "viper mini signature edition", "razer viper mini signature edition"], "razer-viper-mini.webp"),
    ("razer-viper", "razer", "Razer Viper", ids(R, 0x78), ["viper", "razer viper"], "razer-viper.webp"),
    ("logitech-mx-master-3s", "logitech", "Logitech MX Master 3S", ids("046d", 0xc548), ["mx master 3s", "mx master 3"], "logitech-mx-master-3s.png"),
    ("logitech-mx-anywhere-3", "logitech", "Logitech MX Anywhere 3", [], ["mx anywhere 3", "mx anywhere 3s"], "logitech-mx-anywhere-3.png"),
    ("logitech-mx-ergo-s", "logitech", "Logitech MX Ergo S", [], ["mx ergo s", "mx ergo"], "logitech-mx-ergo-s.png"),
    ("finalmouse-ulx", "finalmouse", "Finalmouse Starlight-12 / ULX", ids("361d", 0x100), ["starlight 12", "starlight 12 ulx", "ulx", "finalmouse ulx", "finalmouse starlight 12", "ultralightx"], "finalmouse-ulx.png"),
    ("finalmouse-slx", "finalmouse", "Finalmouse Starlight X (SLX)", [], ["starlight x", "slx", "finalmouse slx"], "finalmouse-slx.png"),
    ("endgame-gear-op1-8k-purple-frost", "endgame-gear", "Endgame Gear OP1 8K Purple Frost", ids("3367", 0x1976), ["op1 8k purple frost", "endgame gear op1 8k purple frost"], "endgame-gear-op1-8k.png"),
    ("vgn-dragonfly-f2", "vgn", "VGN Dragonfly F2 Master+", ids("3554", 0xfb56, 0xfb57), ["dragonfly f2", "dragonfly f2 master", "dragonfly f2 master plus", "vgn dragonfly f2 master plus"], "vgn-dragonfly-f2.png"),
    ("wlmouse-beast-max", "wlmouse", "WLMouse Beast Max", ids("36a7", 0xa880, 0xa881), ["beast max", "wlmouse beast max", "beast x max"], "wlmouse-beast-max.png"),
    ("zaunkoenig-m3k", "zaunkoenig", "Zaunkoenig M3K", ids("0483", 0xa462), ["m3k", "zaunkoenig m3k"], "zaunkoenig-m3k.png"),
    ("teevolution-terra-pro", "teevolution", "Teevolution Terra Pro", ids("3554", 0xf520, 0xf523, 0xf5bb, 0xf522), ["terra pro", "teevolution terra pro"], "teevolution-terra-pro.png"),
    ("crdrako-ko-one", "crdrako", "CRDRAKO KO-ONE", ids("3554", 0x6a, 0x6b), ["ko one", "ko-one", "crdrako ko one"], "crdrako-ko-one.png"),
    ("attack-shark-r5-ultra", "attack-shark", "Attack Shark R5 Ultra", ids("25a7", 0x46, 0x47), ["r5 ultra", "attack shark r5 ultra"], "attackshark-r5-ultra.png"),
]


def jobs():
    out = []
    for key, vendor, name, i, names, f in ROWS:
        fp = RAW / f
        if not fp.exists() or fp.stat().st_size == 0:
            print("missing", f)
            continue
        out.append(job(key, vendor, name, "mouse", i, file=str(fp), url=BASE + f, page="https://openmouse.app", names=[name] + names,
                       note="OpenMouse device image store (img.openmouse.app)"))
    return out
