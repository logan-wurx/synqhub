import sys, requests, concurrent.futures as cf
sys.path.insert(0, ".")
from common import UA

doms = """gravastar.com www.gravastar.com noirgear.com www.noirgear.com noirgear.net wallhack.gg wallhack.com moddomouse.com www.moddomouse.com orbitalgear.com orbitalgaming.co
lunafury.com www.lunafury.com rapoo.com www.rapoo.com global.rapoo.com rawm.com www.rawm.com rawm.store incott.com www.incott.com incott.net incott.store ryunix.com www.ryunix.com
lingbao.com zaunkoenig.com www.zaunkoenig.com redragonshop.com www.redragonshop.com redragon.com ksnake.com k-snake.com www.k-snake.com keychron.com vgnpc.com www.vgnpc.com vgngear.com
delux.com www.deluxworld.com deluxworld.com dareu.com www.dareu.com dareu.store atkgear.com www.atkgear.com atk.gg vxe.gg vxe-gear.com mchose.net mchose.store www.mchose.net
microsoft.com www.microsoft.com store.microsoft.com wlmouse.com www.wlmouse.com wlmouse.gg ninjutso.com www.ninjutso.com glorious.com gloriousgaming.com
kreo-tech.com cosmicbyte.com www.cosmicbyte.in fantechworld.com www.fantechworld.com bloodygaming.com a4tech.com www.a4tech.com a4tech.store xtrfy.com www.xtrfy.com
roccat.com www.roccat.com turtlebeach.com www.turtlebeach.com coolermaster.com www.coolermaster.com evga.com msi.com acer.com lenovo.com dell.com genesis-zone.com
hator.eu hatorgaming.com havit.com havit.hk www.havit.hk trust.com www.trust.com inphic.com www.inphic.com rexus.id ajazz.com ajazzstore.com ajazz.store aulagear.com""".split()


def probe(d):
    try:
        r = requests.get(f"https://{d}/products.json?limit=1", headers=UA, timeout=15, allow_redirects=True)
        ok = "json" in r.headers.get("content-type", "") and r.text.lstrip().startswith("{")
        return d, r.status_code, ok, r.url if r.url.split("/")[2] != d else ""
    except Exception as e:
        return d, 0, False, ""


with cf.ThreadPoolExecutor(12) as ex:
    for d, c, ok, u in ex.map(probe, dict.fromkeys(doms)):
        if ok:
            print("SHOPIFY", d, u)
