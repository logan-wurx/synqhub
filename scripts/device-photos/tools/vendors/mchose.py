"""MCHOSE: renders served by the maker's own M HUB configurator (cdn.mchose.com.cn). One shell covers the A7 V2 Pro / Pro+ / Ultra / Ultra+."""
from common import job

CDN = "https://cdn.mchose.com.cn/configCenter/assets/img/mouse/"


def ids(*pids):
    return [f"{v}:{p:04x}" for v in ("2023", "3837") for p in pids]


def jobs():
    return [
        job("mchose-a7-v2", "mchose", "MCHOSE A7 V2 Pro", "mouse", ids(0x4021, 0x100b), url=CDN + "A7V2Pro_black.png", page="https://www.mchose.net",
            names=["mchose a7 v2 pro", "a7 v2 pro", "a7 v2 pro plus", "a7 v2 ultra", "a7 v2 ultra plus", "a7 v2", "mchose a7 v2"], note="MCHOSE M HUB configurator render (A7V2Pro_black.png)"),
    ]
