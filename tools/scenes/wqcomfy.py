"""Tiny ComfyUI API driver for the wedding-quiz backgrounds.

Needs a local ComfyUI on 127.0.0.1:8188 with sd_xl_base_1.0, the
pixel-art-xl LoRA and the sdxl-vae-fp16-fix VAE. Run the scripts with
ComfyUI's embedded python, which already has Pillow.
"""
import io
import json
import random
import time
import urllib.parse
import urllib.request

from PIL import Image

HOST = "http://127.0.0.1:8188"
CKPT = "sd_xl_base_1.0.safetensors"
LORA = "pixel-art-xl.safetensors"
VAE = "sdxl_vae.safetensors"

STYLE = ("pixel art, 16-bit cozy farming life sim game background, side view, "
         "highly detailed, vibrant soft pastel colors, clean crisp pixels")
NEG = ("text, watermark, signature, logo, letters, people, person, character, animal, "
       "blurry, photo, 3d render, ui, frame, border, vignette, jpeg artifacts")


def _post(path, payload):
    req = urllib.request.Request(HOST + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())


def _get(path):
    return urllib.request.urlopen(HOST + path).read()


def run(graph, timeout=900):
    pid = _post("/prompt", {"prompt": graph, "client_id": "wq"})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        hist = json.loads(_get(f"/history/{pid}"))
        if pid in hist:
            status = hist[pid].get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(json.dumps(status, indent=1)[:2000])
            for node in hist[pid]["outputs"].values():
                for im in node.get("images", []):
                    q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im["subfolder"],
                                                "type": im["type"]})
                    return Image.open(io.BytesIO(_get("/view?" + q))).convert("RGB")
        time.sleep(1.5)
    raise TimeoutError(pid)


def txt2img(prompt, w=1344, h=768, seed=None, steps=30, cfg=6.0, neg=NEG):
    # LoRA strength 1.2 and the fp16-fix VAE are the LoRA author's recommendations.
    return run({
        "ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "lora": {"class_type": "LoraLoader", "inputs": {
            "model": ["ckpt", 0], "clip": ["ckpt", 1], "lora_name": LORA,
            "strength_model": 1.2, "strength_clip": 1.2}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["lora", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": ["lora", 1]}},
        "lat": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {
            "seed": seed if seed is not None else random.randint(1, 2**31), "steps": steps, "cfg": cfg,
            "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
            "model": ["lora", 0], "positive": ["pos", 0], "negative": ["neg", 0],
            "latent_image": ["lat", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"filename_prefix": "wq", "images": ["dec", 0]}},
    })


def pixelate(img, factor=8, colors=40):
    """The LoRA paints on a ~8px grid: box-downsample to the true pixel grid,
    then snap to a small shared palette so it reads as hand-made pixel art."""
    w, h = img.size
    small = img.resize((w // factor, h // factor), Image.BOX)
    return small.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
