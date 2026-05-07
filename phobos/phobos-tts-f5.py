#!/usr/bin/env python3
"""
phobos-tts-f5.py — F5-TTS voice synthesis CLI.

Spawned by AudioServerManager.ts as a one-shot child process.
All parameters via CLI args. Progress lines written to stdout.

Modes:
  tts   — standard synthesis using the base model voice
  clone — zero-shot voice cloning from a reference audio clip

Usage (tts):
  python phobos-tts-f5.py \
    --model-path /path/to/model_1250000.safetensors \
    --vocab-path /path/to/vocab.txt \
    --text "Hello, world." \
    --output /path/to/output.wav \
    --mode tts \
    --speed 1.0 \
    --steps 32 \
    --device cuda

Usage (clone):
  python phobos-tts-f5.py \
    --model-path /path/to/model_1250000.safetensors \
    --vocab-path /path/to/vocab.txt \
    --text "Text to synthesize in the cloned voice." \
    --output /path/to/output.wav \
    --mode clone \
    --ref-audio /path/to/reference.wav \
    --ref-text "Transcript of the reference audio." \
    --speed 1.0 \
    --steps 32 \
    --device cuda
"""

import argparse
import sys
import time
from pathlib import Path


# ── Argument parsing ──────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="PHOBOS F5-TTS voice synthesis")

    p.add_argument("--model-path", required=True,
                   help="Path to F5-TTS model safetensors file")
    p.add_argument("--vocab-path", required=True,
                   help="Path to vocab.txt alongside the model")
    p.add_argument("--text", required=True,
                   help="Text to synthesize")
    p.add_argument("--output", required=True,
                   help="Output WAV file path")
    p.add_argument("--mode", choices=["tts", "clone"], default="tts",
                   help="tts = standard synthesis, clone = zero-shot voice cloning")
    p.add_argument("--ref-audio", default=None,
                   help="Reference audio file for voice cloning (mode=clone)")
    p.add_argument("--ref-text", default=None,
                   help="Transcript of the reference audio (mode=clone, optional)")
    p.add_argument("--speed", type=float, default=1.0,
                   help="Speech speed multiplier (default: 1.0)")
    p.add_argument("--steps", type=int, default=32,
                   help="Diffusion steps (default: 32, higher = slower + better)")
    p.add_argument("--device", default="cpu",
                   help="Torch device: cuda, cuda:0, rocm, cpu (default: cpu)")

    return p


# ── Progress output ───────────────────────────────────────────────────────────

def log(msg: str) -> None:
    """Write a progress line to stdout — AudioServerManager tails these."""
    print(f"[INFO ] {msg}", flush=True)


def die(msg: str) -> None:
    print(f"[ERROR] {msg}", flush=True)
    sys.exit(1)


# ── Device resolution ─────────────────────────────────────────────────────────

def resolve_device(device_arg: str):
    """Resolve the torch device, falling back to CPU on failure."""
    import torch
    if device_arg == "cpu":
        return torch.device("cpu")
    try:
        d = torch.device(device_arg)
        # Force allocation to confirm the device is usable
        torch.zeros(1, device=d)
        return d
    except Exception as e:
        log(f"Device '{device_arg}' unavailable ({e}), falling back to CPU")
        return torch.device("cpu")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args = build_parser().parse_args()

    model_path = Path(args.model_path)
    vocab_path = Path(args.vocab_path)
    output_path = Path(args.output)

    # ── Validate inputs ───────────────────────────────────────────────────────

    if not model_path.exists():
        die(f"Model file not found: {model_path}")
    if not vocab_path.exists():
        die(f"Vocab file not found: {vocab_path}")
    if args.mode == "clone" and not args.ref_audio:
        die("--ref-audio is required for mode=clone")
    if args.ref_audio and not Path(args.ref_audio).exists():
        die(f"Reference audio not found: {args.ref_audio}")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    # ── Imports ───────────────────────────────────────────────────────────────

    log("Importing F5-TTS")
    try:
        import torch
        from f5_tts.api import F5TTS
    except ImportError as e:
        die(f"F5-TTS not installed: {e}\nRun: pip install f5-tts")

    # ── Device ────────────────────────────────────────────────────────────────

    device = resolve_device(args.device)
    log(f"Device: {device}")

    # ── Load model ────────────────────────────────────────────────────────────

    log("Loading F5-TTS model")
    t0 = time.time()

    try:
        tts = F5TTS(
            ckpt_file=str(model_path),
            vocab_file=str(vocab_path),
            device=str(device),
        )
    except Exception as e:
        die(f"Failed to load model: {e}")

    log(f"Model loaded in {time.time() - t0:.1f}s")

    # ── Synthesize ────────────────────────────────────────────────────────────

    log(f"Synthesizing ({args.mode})")
    t1 = time.time()

    if args.mode == "clone":
        ref_audio = args.ref_audio
        ref_text  = args.ref_text or ""
    else:
        # F5-TTS v1 has no reference-free path. Use the bundled English reference
        # shipped with the package for standard TTS mode.
        import importlib.util
        f5_init = importlib.util.find_spec("f5_tts")
        # find_spec returns a ModuleSpec; for namespace packages origin is None
        # but submodule_search_locations gives us the package root directory.
        f5_root = Path(list(f5_init.submodule_search_locations)[0])
        ref_audio = str(f5_root / "infer" / "examples" / "basic" / "basic_ref_en.wav")
        ref_text  = "Some call me nature, others call me mother nature."
        if not Path(ref_audio).exists():
            die(f"Built-in reference audio not found: {ref_audio}")

    try:
        wav, sr, _ = tts.infer(
            ref_file=ref_audio,
            ref_text=ref_text or "",
            gen_text=args.text,
            speed=args.speed,
            nfe_step=args.steps,
        )
    except Exception as e:
        die(f"Synthesis failed: {e}")

    log(f"Synthesis done in {time.time() - t1:.1f}s")

    # ── Write output ──────────────────────────────────────────────────────────

    log(f"Writing {output_path}")
    try:
        import soundfile as sf
        import numpy as np
        audio_np = wav.squeeze().cpu().numpy() if hasattr(wav, 'cpu') else np.array(wav)
        sf.write(str(output_path), audio_np, sr)
    except Exception as e:
        die(f"Failed to write output: {e}")

    elapsed = time.time() - t0
    log(f"Done — {output_path.name} ({elapsed:.1f}s total)")


if __name__ == "__main__":
    main()
