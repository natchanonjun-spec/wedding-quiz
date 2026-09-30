"""Export chosen candidates into the site: python export.py lobby=1 morning=1 ..."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wqcomfy as comfy
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "img", "world")
os.makedirs(SITE, exist_ok=True)

for arg in sys.argv[1:]:
    key, idx = arg.split("=")
    raw = Image.open(os.path.join(OUT, f"{key}_{idx}_raw.png")).convert("RGB")
    px = comfy.pixelate(raw, factor=8, colors=48)
    dest = os.path.join(SITE, f"{key}.png")
    px.save(dest, optimize=True)
    print(key, idx, px.size, os.path.getsize(dest), "bytes")
