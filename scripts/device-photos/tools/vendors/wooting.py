"""Wooting: the product configurator images on wooting.io (their own CDN), ANSI / black default."""
from common import job

CDN = "https://wooting-website.ams3.cdn.digitaloceanspaces.com/products/keyboards/"
ROWS = [
    ("wooting-60he-plus", "Wooting 60HE+", ["31e3:1322"], ["wooting 60he plus", "wooting 60he+", "60he+", "wooting 60he", "60he"], "60HE/configurator-images/w60he-ansi-us-double-shot-pbt-black.jpg", "https://wooting.io/wooting-60he"),
    ("wooting-60he-v2", "Wooting 60HE v2", [], ["wooting 60he v2", "60he v2"], "60HEv2/configurator-images/w60he-v2-pcr-black-ansi-us-double-shot-pbt-black.webp", "https://wooting.io/wooting-60he-v2"),
    ("wooting-80he", "Wooting 80HE", [], ["wooting 80he", "80he", "wooting 80he plus", "80he plus"], "80HE/configurator-images/w80he-pcr-black-ansi-us-double-shot-pbt-black.webp", "https://wooting.io/wooting-80he"),
    ("wooting-two-he", "Wooting Two HE", [], ["wooting two he", "two he", "wooting two"], "W2HE/configurator-images/w2he-ansi-us-abs-black.jpg", "https://wooting.io/wooting-two-he"),
]


def jobs():
    return [job(k, "wooting", n, "keyboard", ids, url=CDN + path, page=pg, names=[n] + names, note="wooting.io product configurator image") for k, n, ids, names, path, pg in ROWS]
