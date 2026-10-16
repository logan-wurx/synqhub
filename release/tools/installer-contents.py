"""
Looks inside an NSIS installer WITHOUT running it, to check what it will put on a PC.

  python release/tools/installer-contents.py <installer.exe> --expect <file> [--expect <file> ...]

The installer is /SOLID lzma: one LZMA stream after NSIS's first header. This decompresses it in
memory (nothing is written, nothing is run) and then:
  - prints the installer script's own strings that matter (what the post-install hook runs, which
    files are laid down, the registry keys it writes, the WebView2 step),
  - for each --expect file, checks that its exact bytes (and SHA-256) are inside the installer.
Exit code 1 if any expected file is missing or any user-profile path ("C:\\Users\\...") shows up.
"""
import hashlib
import lzma
import re
import struct
import sys


def load(path):
    d = open(path, "rb").read()
    sig = bytes.fromhex("efbeadde") + b"NullsoftInst"
    i = d.find(sig)
    if i < 0:
        sys.exit("Not an NSIS installer (no NullsoftInst header).")
    inflated_header, following = struct.unpack("<II", d[i + 16 : i + 24])
    body = d[i + 24 :]
    props = body[0]
    dict_size = struct.unpack("<I", body[1:5])[0]
    lc, rest = props % 9, props // 9
    lp, pb = rest % 5, rest // 5
    filters = [{"id": lzma.FILTER_LZMA1, "lc": lc, "lp": lp, "pb": pb, "dict_size": max(dict_size, 4096)}]
    dec = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=filters)
    out = bytearray()
    data = body[5:]
    for pos in range(0, len(data), 1 << 20):
        out += dec.decompress(data[pos : pos + (1 << 20)])
        if dec.eof:
            break
    return len(d), inflated_header, bytes(out)


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    path = args[0]
    expect = [args[i + 1] for i, a in enumerate(args) if a == "--expect"]
    size, header_len, out = load(path)
    print(f"{path}\n  {size} bytes on disk; script header {header_len} bytes; payload stream {len(out)} bytes when unpacked")

    header = out[:header_len]
    strings = set(re.findall(r"[ -~]{6,}", header.decode("utf-16le", errors="ignore")))
    strings |= set(re.findall(rb"[ -~]{6,}", header))  # ANSI builds, harmless on unicode ones
    strings = {s if isinstance(s, str) else s.decode("latin1") for s in strings}
    interesting = re.compile(r"(--eq-engine|eq-engine\\|\.exe\b|Uninstall\\|Software\\|Equalizer|WebView|Setting up)", re.I)
    print("  installer script strings of interest:")
    for s in sorted(strings):
        if interesting.search(s):
            print("    ", s[:150])

    bad = 0
    for f in expect:
        blob = open(f, "rb").read()
        at = out.find(blob)
        sha = hashlib.sha256(blob).hexdigest()
        note = ""
        if at < 0 and b"__TAURI_BUNDLE_TYPE_VAR_UNK" in blob:
            # Tauri stamps the bundle type ("NSS" for NSIS) into the copy it packs, then puts "UNK" back.
            blob = blob.replace(b"__TAURI_BUNDLE_TYPE_VAR_UNK", b"__TAURI_BUNDLE_TYPE_VAR_NSS")
            at = out.find(blob)
            note = "  (identical except Tauri's 3-byte bundle-type stamp UNK -> NSS)"
        if at >= 0:
            print(f"  FOUND  {len(blob):>10} bytes  sha256 {sha}  {f}{note}")
        else:
            print(f"  MISSING (exact bytes not in the installer): {f}")
            bad += 1
    script_text = header.decode("utf-16le", errors="ignore")
    hits = re.findall(r"[A-Za-z]:\\Users\\[ -~]{1,60}", script_text) + [m.decode("latin1") for m in re.findall(rb"[A-Za-z]:\\Users\\[ -~]{1,60}", bytes(out[:header_len]))]
    if hits:
        print("  user-profile paths in the installer script:", hits[:5])
        bad += 1
    else:
        print("  no user-profile paths in the installer script")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
