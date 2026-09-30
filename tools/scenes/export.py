"""Put chosen candidates into the site: python export.py lobby=1 morning=0 ...

Each one is re-painted at 2x in one pass, then at 2x again in SDXL-sized tiles
(so the LoRA's ~8px pixel grid lands on four times as many pixels - same
picture, four times the detail) and snapped to a real 672x384 pixel grid.
~12 min per scene on an RTX 3060.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wqcomfy as comfy
from make_scenes import NEG, OUT, prompt_for
from PIL import Image

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "img", "world")
# Each tile is a close-up with no idea which scene it belongs to, so it gets a
# style-only prompt - the scene prompt would paint a new arch/gazebo in every tile.
TILE_PROMPT = ("pixel art, 16-bit cozy life sim game background, highly detailed, intricate, soft warm pastel "
               "colors, clean crisp pixels, sharp pixel outlines")

if __name__ == "__main__":
    os.makedirs(SITE, exist_ok=True)
    for arg in sys.argv[1:]:
        key, idx = arg.split("=")
        raw = Image.open(os.path.join(OUT, f"{key}_{idx}_raw.png")).convert("RGB")
        hi = comfy.redetail(raw, prompt_for(key), neg=NEG)
        hi.save(os.path.join(OUT, f"{key}_hi.png"))
        hi4 = comfy.tiled_redetail(hi, TILE_PROMPT, denoise=0.4, neg=NEG)
        hi4.save(os.path.join(OUT, f"{key}_4x.png"))
        px = comfy.pixelate(hi4, factor=8, colors=96)
        dest = os.path.join(SITE, f"{key}.png")
        px.save(dest, optimize=True)
        print(key, idx, px.size, os.path.getsize(dest), "bytes", flush=True)
