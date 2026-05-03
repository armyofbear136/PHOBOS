"""
phobos-convert.py — one-time PyTorch variant converter
Converts a monolithic GGUF or single-file safetensors model into a split
diffusers directory (from_pretrained compatible) that can be loaded without
from_single_file, bypassing the diffusers 0.36 / transformers 4.52 CLIP issue.

Output: ~/.phobos/models/image/pytorch/<model-id>/
Progress: emitted to stdout as JSON lines { "phase", "pct", "label" }
Errors:   emitted to stdout as { "phase": "error", "message" }

Supported model types: sdxl
"""

import argparse
import json
import os
import sys
import time


# ── Progress helpers ──────────────────────────────────────────────────────────

def emit(phase: str, pct: float, label: str):
    print(json.dumps({"phase": phase, "pct": round(pct, 3), "label": label}), flush=True)

def emit_error(message: str):
    print(json.dumps({"phase": "error", "message": message}), flush=True)


# ── Args ──────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="Convert image model to PyTorch diffusers format")
    p.add_argument("--model-path",   required=True,  help="Source model file (.gguf or .safetensors)")
    p.add_argument("--model-type",   required=True,  choices=["sdxl"], help="Model architecture")
    p.add_argument("--model-id",     required=True,  help="Phobos model ID (used as output directory name)")
    p.add_argument("--output-dir",   required=True,  help="Root output directory — model written to <output-dir>/<model-id>/")
    p.add_argument("--dtype",        default="bfloat16", choices=["bfloat16", "float16", "float32"])
    return p.parse_args()


# ── SDXL conversion ───────────────────────────────────────────────────────────

def convert_sdxl(model_path: str, out_dir: str, dtype_str: str):
    """
    Load SDXL from a monolithic safetensors/GGUF via from_single_file,
    then save as a split diffusers directory via save_pretrained.

    This is the one-time cost. Subsequent loads use from_pretrained which
    works with any diffusers/transformers version and loads ~3x faster.
    """
    import torch
    from diffusers import StableDiffusionXLPipeline

    dtype_map = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}
    dtype = dtype_map[dtype_str]

    emit("loading", 0.0, f"Loading {os.path.basename(model_path)} via from_single_file…")
    t0 = time.time()

    # Load on CPU — we are not generating, just converting. No GPU needed.
    pipe = StableDiffusionXLPipeline.from_single_file(
        model_path,
        torch_dtype=dtype,
        use_safetensors=True,
    )

    load_time = time.time() - t0
    emit("saving", 0.5, f"Loaded in {load_time:.1f}s — saving diffusers directory…")

    os.makedirs(out_dir, exist_ok=True)
    pipe.save_pretrained(out_dir, safe_serialization=True)

    # Free memory immediately — caller may launch generation right after
    del pipe
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass

    total_time = time.time() - t0
    emit("done", 1.0, f"Conversion complete in {total_time:.1f}s → {out_dir}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()

    out_dir = os.path.join(args.output_dir, args.model_id)

    if os.path.isdir(out_dir) and os.path.exists(os.path.join(out_dir, "model_index.json")):
        # Already converted — emit done immediately so caller knows it's safe to proceed
        emit("done", 1.0, f"Already converted — {out_dir}")
        return

    if not os.path.exists(args.model_path):
        emit_error(f"Source model not found: {args.model_path}")
        sys.exit(1)

    try:
        if args.model_type == "sdxl":
            convert_sdxl(args.model_path, out_dir, args.dtype)
        else:
            emit_error(f"Unsupported model type for conversion: {args.model_type}")
            sys.exit(1)
    except Exception as e:
        emit_error(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
