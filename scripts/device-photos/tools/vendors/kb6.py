"""Sonix / FCC Hall-effect boards (the white-label boards of src/lib/kb/fcc/sonix-catalog.generated.ts), final pass: the
pictures the boards' own web driver shows for them. The catalogue FCC reads is the official VTER / driveall web driver's
(vter.driveall.cn); its bundle names a picture for each device name it knows (a switch from the name the board reports to
a file under static/img). The bundle was read as text, never run. Only names whose picture is the board's own are used:
a picture the driver shows for several different boards (gs68.png for the EWEADN BAT68, Onikuma G67 and Tank68 HE;
key_64.png for "GamingKeyboard"; a 98-key picture for the TH068) is left out, and those boards stay drawn from their
layout. Found by name (the vendor id 0C45 is Sonix's, shared by hundreds of boards). Steps: cands2.py kb6, picks/kb6.json,
build2.py kb6, assemble2.py."""
from rows import R, make

VTER = "https://vter.driveall.cn/static/img/"

# (picture key, display name, the names the boards report that the driver shows this picture for, file)
BOARDS = [
    ("sonix-61key-cz", "61KEY-CZ Gaming Keyboard", ["61key cz gaming keyboard"], "61KEY-CZ.4004335.png"),
    ("sonix-cz-206", "CZ-206", ["cz 206"], "CZ-206.790b4c1.png"),
    ("sonix-vter-fighting98", "VTER Fighting98", ["fighting98", "vter fighting98"], "98.a6d593d.png"),
    ("sonix-gs3068", "GS3068", ["gs3068c", "gs3068 mag"], "GS3068-MAG.03c3fb5.png"),
    ("sonix-hk8301g", "HK8301G", ["hk8301g", "tk200"], "HK8301G.edec849.png"),
    ("sonix-kb-820c", "KB-820C", ["kb 820c"], "820C.0269d08.png"),
    ("sonix-kx68he", "KX68HE", ["kx68he"], "KX68HE.87ce685.png"),
    ("sonix-looting60-pro", "Looting60 Pro", ["looting60 pro"], "looting60.5314603.png"),
    ("sonix-looting63", "Looting63", ["looting63", "lukit63"], "looting63.4069128.png"),
    ("sonix-looting66-pro", "Looting66 Pro", ["looting66 pro"], "looting66pro.b51bb03.png"),
    ("sonix-looting68-pro", "Looting68 Pro", ["looting68 pro"], "looting68.7d1fe2e.png"),
    ("sonix-looting75-pro", "Looting75 Pro", ["looting75 pro"], "looting75pro.05f513f.png"),
    ("sonix-luminor-68", "Luminor 68", ["luminor 68"], "USBKeyboard.70f21a5.png"),
    ("sonix-mc68", "MC68", ["mc68"], "GamingKeyboard.0c9033c.png"),
    ("sonix-mini-60-he", "MINI 60 HE", ["mini 60 he", "mini 60 he pro", "mini60he max", "win 60 he"], "2860.e551371.png"),
    ("sonix-mk75", "MK75 Keyboard", ["mk75keyboard", "mk75 keyboard"], "MK75Keyboard.091ae25.png"),
    ("sonix-qsenn-dt35", "QSENN DT35", ["qsenn dt35 104", "dt dt35 104"], "dt35.dfe14cf.png"),
    ("sonix-red-star-980", "Red Star 980", ["red star 980"], "red_star_980.1d0407e.png"),
    ("sonix-rk739", "RK739", ["rk739"], "rk762.25c0457.png"),
    ("sonix-star75-mag", "STAR75-MAG", ["star75 mag"], "STAR75.3bfe08c.png"),
    ("sonix-sunny75", "Sunny75", ["sunny75"], "sunny75.8f91e5b.png"),
    ("sonix-sunny80-he", "Sunny80 HE", ["sunny80 he"], "sunny80he.d682864.png"),
    ("sonix-si-2810", "SI-2810 (A80)", ["si 2810", "si 2810c", "a80 pro", "a80rt", "a80rt u"], "SI-2810.2c77b43.png"),
]

ROWS = [R(key, "sonix", name, "keyboard", [("img", VTER + f)], names=names, page="https://vter.driveall.cn/",
          note="the boards' own web driver (vter.driveall.cn, the catalogue FCC reads), its picture for this board")
        for key, name, names, f in BOARDS]

candidates, jobs = make("kb6", ROWS)
