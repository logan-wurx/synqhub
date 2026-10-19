"""The headsets SYNQ drives (src/lib/headsets/headsets.json) that the first headset pass left drawn: Logitech's G PRO X
Wireless (and the G PRO wireless, id 0AA7, the same shell), G633 / G635 / G933 / G935, whose logitechg.com pages are gone
(the Wayback Machine's copies, pictures from Logitech's own image server), and HyperX's Cloud II Wireless (hyperx.com, HyperX's
Shopify store). Steps: cands2.py headsets2, picks/headsets2.json, build2.py headsets2, assemble2.py."""
from rows import R, make

LG = "logitechg.com/en-us/products/gaming-audio/"
DAM = r"resource\.logitechg\.com/.*content/dam/gaming/en/products/"
PIC = "https://resource.logitechg.com/w_1600,c_limit,f_png/d_transparent.gif/content/dam/gaming/en/products/"


def i(*pids):
    return [f"046d:{p:04x}" for p in pids]


ROWS = [
    R("logitech-pro-x-wireless", "logitech", "PRO X Wireless", "headset",
      [("img", PIC + f"pro-wireless/pro-wireless-headset-gallery-{n}.png") for n in range(1, 5)],
      ids=i(0x0aa7, 0x0aaa, 0x0aba), names=["pro x wireless", "g pro x wireless", "pro x wireless lightspeed", "pro wireless headset", "g pro wireless headset", "pro x lightspeed"],
      page="https://www.logitechg.com/en-us/shop/p/pro-x-wireless-headset", note="logitechg.com product page, gallery render"),
    R("logitech-g633", "logitech", "G633 Artemis Spectrum", "headset",
      [("wbgrab", LG + "g633-7-1-surround-sound-gaming-headset.981-000586.html", DAM + r"g633"), ("wbgrab", LG + "g633-7-1-surround-sound-gaming-headset.html", DAM + r"g633")],
      ids=i(0x0a5c), names=["g633", "g633 artemis spectrum", "g633s"], note="logitechg.com product page as the Wayback Machine kept it"),
    R("logitech-g635", "logitech", "G635", "headset",
      [("wbgrab", LG + "g635-7-1-surround-sound-gaming-headset.981-000748.html", DAM + r"g635"), ("wbgrab", LG + "g635-7-1-surround-sound-lightsync-gaming-headset.html", DAM + r"g635")],
      ids=i(0x0a89), names=["g635", "g635 lightsync"], note="logitechg.com product page as the Wayback Machine kept it"),
    R("logitech-g933", "logitech", "G933 Artemis Spectrum", "headset",
      [("wbgrab", LG + "g933-7-1-surround-sound-gaming-headset.981-000585.html", DAM + r"g933"), ("wbgrab", LG + "g933-7-1-surround-sound-gaming-headset.html", DAM + r"g933")],
      ids=i(0x0a5b), names=["g933", "g933 artemis spectrum", "g933s"], note="logitechg.com product page as the Wayback Machine kept it"),
    R("logitech-g935", "logitech", "G935", "headset",
      [("wbgrab", LG + "g935-wireless-7-1-surround-sound-lightsync-gaming-headset.981-000742.html", DAM + r"g935"),
       ("wbgrab", LG + "g935-wireless-7-1-surround-sound-lightsync-gaming-headset.html", DAM + r"g935")],
      ids=i(0x0a87), names=["g935", "g935 wireless", "g935 lightsync"], note="logitechg.com product page as the Wayback Machine kept it"),
    R("hyperx-cloud-ii-wireless", "hyperx", "HyperX Cloud II Wireless", "headset", [("shop", "hyperx.com", "hyperx-cloud-ii-wireless")],
      ids=["03f0:0696", "03f0:018b"], names=["cloud ii wireless", "hyperx cloud ii wireless", "cloud 2 wireless"], note="hyperx.com (HyperX's own store)"),
]

candidates, jobs = make("headsets2", ROWS)
