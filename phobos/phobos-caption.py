#!/usr/bin/env python3
"""
phobos-caption.py — Florence-2 caption generation for plugin training images.

Spawned by CaptionProcessor.ts. Reads images from a directory, generates
detailed captions with Florence-2, writes captions.json.

Progress lines emitted to stdout (parsed by CaptionProcessor.ts):
  PROGRESS N/TOTAL
  CAPTION filename|||caption text
  DONE
  ERROR message
"""

import argparse
import json
import os
import sys
from pathlib import Path

SUPPORTED_EXTS = {'.png', '.jpg', '.jpeg', '.webp', '.tiff', '.bmp'}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="PHOBOS Florence-2 captioner")
    p.add_argument("--image-dir",    required=True, help="Directory of training images")
    p.add_argument("--output-file",  required=True, help="Path to write captions.json")
    p.add_argument("--model-cache",  default=None,  help="HF model cache dir (default: ~/.cache/huggingface)")
    p.add_argument("--task",         default="<DETAILED_CAPTION>",
                   help="Florence-2 task token")
    p.add_argument("--device",       default="auto", help="cuda / cpu / auto")
    p.add_argument("--trigger-word", default="",    help="Prepend trigger word to every caption")
    return p


def pick_device(requested: str) -> str:
    import torch
    if requested == "auto":
        if torch.cuda.is_available():    return "cuda"
        if hasattr(torch, "xpu") and torch.xpu.is_available(): return "xpu"
        try:
            if torch.backends.mps.is_available(): return "mps"
        except Exception:
            pass
        return "cpu"
    return requested


def load_image(path: str):
    """Load image as RGB PIL Image, resize+letterbox to 512×512."""
    from PIL import Image
    img = Image.open(path).convert("RGB")
    img.thumbnail((512, 512), Image.LANCZOS)
    # Pad to exact 512×512 with black
    canvas = Image.new("RGB", (512, 512), (0, 0, 0))
    offset = ((512 - img.width) // 2, (512 - img.height) // 2)
    canvas.paste(img, offset)
    return canvas


def main() -> None:
    args = build_parser().parse_args()

    image_dir = Path(args.image_dir)
    if not image_dir.is_dir():
        print(f"ERROR image dir not found: {image_dir}", flush=True)
        sys.exit(1)

    images = sorted(
        p for p in image_dir.iterdir()
        if p.suffix.lower() in SUPPORTED_EXTS
    )

    if not images:
        print("ERROR no supported images found in directory", flush=True)
        sys.exit(1)

    # ── Load model ────────────────────────────────────────────────────────────
    try:
        import torch
        from transformers import AutoProcessor, AutoModelForCausalLM
    except ImportError as e:
        print(f"ERROR missing dependency: {e}", flush=True)
        sys.exit(1)

    device    = pick_device(args.device)
    dtype     = torch.float16 if device in ("cuda", "xpu") else torch.float32
    # Default cache to ~/.phobos/models/vision/ so Florence-2 lands alongside
    # other PHOBOS vision models instead of ~/.cache/huggingface/
    import os as _os
    cache_dir = args.model_cache or _os.path.join(_os.path.expanduser("~"), ".phobos", "models", "vision")

    print(f"PROGRESS 0/{len(images)}", flush=True)

    try:
        processor = AutoProcessor.from_pretrained(
            "microsoft/Florence-2-base",
            trust_remote_code=True,
            cache_dir=cache_dir,
        )
        model = AutoModelForCausalLM.from_pretrained(
            "microsoft/Florence-2-base",
            torch_dtype=dtype,
            trust_remote_code=True,
            cache_dir=cache_dir,
        ).to(device)
        model.eval()
    except Exception as e:
        print(f"ERROR loading Florence-2: {e}", flush=True)
        sys.exit(1)

    # ── Caption each image ────────────────────────────────────────────────────
    captions: dict[str, str] = {}
    trigger   = args.trigger_word.strip()
    task_tok  = args.task

    for i, img_path in enumerate(images):
        try:
            pil_img = load_image(str(img_path))
            inputs  = processor(
                text=task_tok,
                images=pil_img,
                return_tensors="pt",
            ).to(device, dtype)

            with torch.no_grad():
                ids = model.generate(
                    input_ids=inputs["input_ids"],
                    pixel_values=inputs["pixel_values"],
                    max_new_tokens=256,
                    num_beams=3,
                )

            raw    = processor.batch_decode(ids, skip_special_tokens=False)[0]
            parsed = processor.post_process_generation(
                raw, task=task_tok,
                image_size=(pil_img.width, pil_img.height),
            )
            caption_text = parsed.get(task_tok, "").strip()

            if trigger:
                caption_text = f"{trigger}, {caption_text}" if caption_text else trigger

            captions[img_path.name] = caption_text
            # Pipe-delimited so TS parser can split on ||| without worrying about
            # commas or quotes inside caption text
            safe_caption = caption_text.replace("|||", "")
            print(f"CAPTION {img_path.name}|||{safe_caption}", flush=True)

        except Exception as e:
            # Non-fatal — emit empty caption, continue
            captions[img_path.name] = trigger or ""
            print(f"CAPTION {img_path.name}|||{trigger or ''}", flush=True)
            print(f"WARN caption failed for {img_path.name}: {e}", flush=True)

        print(f"PROGRESS {i + 1}/{len(images)}", flush=True)

    # ── Write output ──────────────────────────────────────────────────────────
    output_path = Path(args.output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(captions, f, indent=2, ensure_ascii=False)

    print("DONE", flush=True)


if __name__ == "__main__":
    main()
