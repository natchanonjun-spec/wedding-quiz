"""Generate candidate wedding scenes with a local ComfyUI (see README).

usage: python make_scenes.py <scene> [<scene> ...] [--n 3]
Writes out/<scene>_<i>_raw.png. Pick one per scene, then:
  python export.py <scene>=<i> ...   (re-paints at 2x and snaps into public/img/world)
"""
import os
import sys

# ComfyUI's embedded python has its own "comfy" package on the path, hence
# the explicit path + distinct module name.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wqcomfy as comfy

STYLE = ("pixel art, 16-bit cozy life sim game background, highly detailed, soft warm pastel colors, "
         "clean crisp pixels, no people")
NEG = comfy.NEG + ", people, bride, groom, crowd"

SCENES = {
    "lobby": "outdoor garden wedding entrance, big white flower arch covered in roses and ivy framing the view, "
             "rose petals on a stone path, string lights, rolling green hills, blue sky with fluffy clouds, "
             "sunny morning",
    # The quiz walks through the wedding day: ceremony, reception, cake, party.
    "morning": "outdoor garden wedding ceremony in the morning, rows of white wooden chairs on both sides of an "
               "aisle scattered with pink rose petals, flower arch altar at the end, blossoming trees, soft pink "
               "sunrise sky, light mist",
    "noon": "outdoor garden wedding reception at noon, long banquet tables with white tablecloths and flower "
            "centerpieces, colorful bunting flags, big shady oak tree, green lawn, bright blue sky with fluffy "
            "clouds",
    "sunset": "romantic wedding gazebo decorated with flowers and string lights at golden hour sunset, two tall "
              "crystal wine glasses filled with red wine and a bottle of red wine on a small round bistro table, "
              "paper lanterns, orange pink and purple sky, warm glow",
    "night": "wedding reception party at night, glowing string lights and paper lanterns hanging across the "
             "sky, fairy lights in the trees, wooden dance floor, flower decorations, starry deep blue sky, "
             "full moon",
    # The finale zooms into this one's vanishing point: keep it centered.
    "goal": "first person view walking straight down a wedding aisle at night, rose petals on the aisle, white "
            "chairs and glowing lanterns on both sides, flower arch altar far away in the exact center, starry "
            "deep blue sky, full moon, perfectly symmetrical composition, centered vanishing point",
}

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


def prompt_for(scene):
    return SCENES[scene] + ", " + STYLE


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    args = sys.argv[1:]
    n = 3
    if "--n" in args:
        n = int(args[args.index("--n") + 1])
        del args[args.index("--n"):args.index("--n") + 2]
    for scene in args:
        for i in range(n):
            img = comfy.txt2img(prompt_for(scene), seed=3000 + i * 15485863, neg=NEG)
            img.save(os.path.join(OUT, f"{scene}_{i}_raw.png"))
            print(scene, i, flush=True)
