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

from PIL import Image, ImageChops

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


def _upload(img, name):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    boundary = "wqboundary7361"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + buf.getvalue() + \
           f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(HOST + "/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.loads(urllib.request.urlopen(req).read())["name"]


def redetail(img, prompt, denoise=0.5, seed=777, neg=NEG):
    """Repaint an image at 2x with the same prompt. Denoise 0.5 keeps the
    composition while the LoRA redraws its pixel grid at the finer scale.
    Tiled VAE keeps the 2688x1536 encode/decode inside 12GB of VRAM."""
    w, h = img.size
    name = _upload(img.resize((w * 2, h * 2), Image.LANCZOS), "wq_big.png")
    tiled = {"tile_size": 1024, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}
    return run({
        "ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "lora": {"class_type": "LoraLoader", "inputs": {
            "model": ["ckpt", 0], "clip": ["ckpt", 1], "lora_name": LORA,
            "strength_model": 1.2, "strength_clip": 1.2}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["lora", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": ["lora", 1]}},
        "img": {"class_type": "LoadImage", "inputs": {"image": name}},
        "enc": {"class_type": "VAEEncodeTiled", "inputs": dict(tiled, pixels=["img", 0], vae=["vae", 0])},
        "ks": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 30, "cfg": 6.0, "sampler_name": "dpmpp_2m", "scheduler": "karras",
            "denoise": denoise, "model": ["lora", 0], "positive": ["pos", 0], "negative": ["neg", 0],
            "latent_image": ["enc", 0]}},
        "dec": {"class_type": "VAEDecodeTiled", "inputs": dict(tiled, samples=["ks", 0], vae=["vae", 0])},
        "save": {"class_type": "SaveImage", "inputs": {"filename_prefix": "wq", "images": ["dec", 0]}},
    }, timeout=1800)


def _img2img(name, prompt, denoise, seed, neg=NEG, steps=30):
    return run({
        "ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "lora": {"class_type": "LoraLoader", "inputs": {
            "model": ["ckpt", 0], "clip": ["ckpt", 1], "lora_name": LORA,
            "strength_model": 1.2, "strength_clip": 1.2}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["lora", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": ["lora", 1]}},
        "img": {"class_type": "LoadImage", "inputs": {"image": name}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["img", 0], "vae": ["vae", 0]}},
        "ks": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": 6.0, "sampler_name": "dpmpp_2m", "scheduler": "karras",
            "denoise": denoise, "model": ["lora", 0], "positive": ["pos", 0], "negative": ["neg", 0],
            "latent_image": ["enc", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"filename_prefix": "wq", "images": ["dec", 0]}},
    })


def tiled_redetail(img, prompt, denoise=0.4, seed=777, tile=(1344, 768), overlap=192, neg=NEG):
    """Another 2x on top of redetail(): too big for one SDXL pass, so it is
    re-painted in SDXL-sized tiles (each a close-up the LoRA draws its ~8px grid
    into) and feathered back together. Low denoise keeps the tiles agreeing."""
    w, h = img.size[0] * 2, img.size[1] * 2
    big = img.resize((w, h), Image.LANCZOS)
    tw, th = tile

    def starts(total, size):
        n = max(1, -(-(total - overlap) // (size - overlap)))
        return [round(i * (total - size) / max(1, n - 1)) for i in range(n)]

    acc = Image.new("RGB", (w, h))
    weight = Image.new("L", (w, h), 0)
    for y in starts(h, th):
        for x in starts(w, tw):
            crop = big.crop((x, y, x + tw, y + th))
            out = _img2img(_upload(crop, "wq_tile.png"), prompt, denoise, seed + x + y * 7, neg)
            # Feather mask: ramps over the overlap on inner edges only
            # (min of a per-column and a per-row ramp).
            def ramp(n, lo, hi):
                return [int(255 * max(0.0, min(1.0, (i / overlap) if lo else 1.0,
                                               ((n - 1 - i) / overlap) if hi else 1.0))) for i in range(n)]
            cols = Image.new("L", (tw, 1)); cols.putdata(ramp(tw, x > 0, x + tw < w))
            rows = Image.new("L", (1, th)); rows.putdata(ramp(th, y > 0, y + th < h))
            mask = ImageChops.darker(cols.resize((tw, th), Image.NEAREST), rows.resize((tw, th), Image.NEAREST))
            # Paste over what's there, weighted by the mask; the first tile at
            # any spot is fully opaque, so feathered edges blend into it.
            region = acc.crop((x, y, x + tw, y + th))
            wreg = weight.crop((x, y, x + tw, y + th))
            m = Image.composite(mask, Image.new("L", (tw, th), 255), wreg)
            acc.paste(Image.composite(out, region, m), (x, y))
            weight.paste(Image.new("L", (tw, th), 255), (x, y))
            print(f"  tile {x},{y}", flush=True)
    return acc


def pixelate(img, factor=8, colors=40):
    """The LoRA paints on a ~8px grid: box-downsample to the true pixel grid,
    then snap to a small shared palette so it reads as hand-made pixel art."""
    w, h = img.size
    small = img.resize((w // factor, h // factor), Image.BOX)
    return small.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
