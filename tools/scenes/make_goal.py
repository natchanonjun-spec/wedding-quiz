"""Candidates for the goal-run finale: a first-person view down the farm path
at night toward a finish arch, composed around a centered vanishing point so
the page can zoom straight into it."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wqcomfy as comfy

PROMPT = ("pixel art, 16-bit cozy farming life sim game, first person view looking straight down a long "
          "dirt path through a farm at night, the path leads to a flower arch finish line far away in the "
          "exact center, glowing paper lanterns hanging along both sides of the path, wooden fences on both "
          "sides, fireflies, starry deep blue sky, full moon, perfectly symmetrical composition, centered "
          "vanishing point, highly detailed, clean crisp pixels")
NEG = comfy.NEG + ", side view, asymmetrical, tilted"

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)

n = int(sys.argv[1]) if len(sys.argv) > 1 else 4
for i in range(n):
    seed = 2000 + i * 104729
    img = comfy.txt2img(PROMPT, seed=seed, neg=NEG)
    img.save(os.path.join(OUT, f"goal_{i}_raw.png"))
    print("goal", i, seed, flush=True)
