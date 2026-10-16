"""Contact sheet: python sheet.py out.png cols cell bg(hex) file1 file2 ... -> labelled grid of images on a flat background."""
import sys
from PIL import Image, ImageDraw
out, cols, cell, bg = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
files = sys.argv[5:]
rows = (len(files) + cols - 1) // cols
bgc = tuple(int(bg.lstrip('#')[i:i+2], 16) for i in (0, 2, 4))
sheet = Image.new("RGB", (cols * cell, rows * (cell + 16)), bgc)
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    try:
        im = Image.open(f).convert("RGBA")
    except Exception as e:
        d.text(((i % cols) * cell + 4, (i // cols) * (cell + 16) + 4), "ERR", fill=(255, 0, 0)); continue
    im.thumbnail((cell - 8, cell - 8))
    x, y = (i % cols) * cell, (i // cols) * (cell + 16)
    sheet.paste(im, (x + (cell - im.width) // 2, y + 16 + (cell - im.height) // 2), im)
    d.text((x + 3, y + 2), f.replace("\\", "/").split("/")[-1][:cell // 6], fill=(255, 255, 0) if sum(bgc) < 300 else (200, 0, 0))
sheet.save(out)
print(out, sheet.size)
