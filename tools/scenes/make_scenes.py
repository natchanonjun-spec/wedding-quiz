"""Generate candidate background scenes with a local ComfyUI (see README).

usage: python make_scenes.py <scene> [candidates]
Writes candidates to out/<scene>_<n>_raw.png (+ _px.png pixelated preview).
Pick one, then: python export.py <scene>=<n> to put it in public/img/world.
"""
import os
import sys

# ComfyUI's embedded python has its own "comfy" package on the path, hence
# the explicit path + distinct module name.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wqcomfy as comfy

SCENES = {
    # Lobby: a garden wedding on the farm - where the guests are running to.
    "lobby": "wide open landscape view with a big calm sky, cozy countryside farm garden wedding at a bright sunny morning, "
             "white flower arch decorated with roses in the distance, string lights, blue sky with fluffy "
             "white clouds, rolling green hills, blossoming cherry trees, wildflower meadow, wooden fence, "
             "small red barn far away",
    # The quiz walks through one day on the farm, morning to night.
    "morning": "wide open landscape view with a big calm sky, cozy farm valley at early sunrise, soft pink and peach sky, "
               "light mist, rolling green hills, wooden farmhouse with warm windows, fruit trees, "
               "crop fields, wooden fence, small pond",
    "noon": "wide open landscape view with a big calm sky, cozy farm on a bright sunny day, clear blue sky with big fluffy "
            "clouds, green meadow, tall oak trees, windmill, sunflower field, wooden fence, stone path",
    "sunset": "wide open landscape view with a big calm sky, cozy farm at golden hour sunset, orange pink and purple sky, "
              "warm glowing sun near the horizon, autumn orange trees, hay bales, barn, "
              "long shadows, wooden fence",
    "night": "wide open landscape view with a big calm sky, cozy farm at night, starry deep blue sky, big full moon, "
             "fireflies, warm glowing paper lanterns and string lights, farmhouse with glowing windows, "
             "dark blue hills, wooden fence",
}

OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)


def prompt_for(scene):
    return SCENES[scene] + ", " + comfy.STYLE


def candidates(scene, n):
    for i in range(n):
        seed = 1000 + i * 7919
        img = comfy.txt2img(prompt_for(scene), seed=seed)
        img.save(os.path.join(OUT, f"{scene}_{i}_raw.png"))
        comfy.pixelate(img).save(os.path.join(OUT, f"{scene}_{i}_px.png"))
        print(scene, i, "seed", seed, flush=True)


if __name__ == "__main__":
    candidates(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 3)
