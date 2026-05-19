#!/usr/bin/env python3
"""
phobos-music-acestep.py — ACE-Step v1.5 GPU music generation subprocess

Protocol (stdout):
  [INFO ] <message>      — progress / status lines
  [DONE ] <output_path>  — success, final WAV path
  [ERROR] <message>      — fatal error, exit 1

Called by AudioServerManager.generateAceStep via runProcess().
"""

import argparse
import inspect
import os
import random
import sys
import time


def info(msg: str) -> None:
    print(f"[INFO ] {msg}", flush=True)


def done(path: str) -> None:
    print(f"[DONE ] {path}", flush=True)


def error(msg: str) -> None:
    print(f"[ERROR] {msg}", flush=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--checkpoint-path", required=True,
                   help="Path to ACE-Step v1.5 snapshot directory")
    p.add_argument("--prompt",   required=True,
                   help="Music style/tag description (max 512 chars)")
    p.add_argument("--lyrics",   default="[Instrumental]",
                   help="Structured lyrics with [verse]/[chorus] tags, or [Instrumental]")
    p.add_argument("--duration", type=float, default=30.0,
                   help="Target audio duration in seconds")
    p.add_argument("--steps",    type=int,   default=60,
                   help="Number of diffusion inference steps")
    p.add_argument("--cfg",      type=float, default=15.0,
                   help="Guidance scale (classifier-free guidance strength)")
    p.add_argument("--seed",     type=int,   default=-1,
                   help="Random seed (-1 = random)")
    p.add_argument("--device", default="cuda:0",
                   help="Torch device string: cuda:0, cuda:1, xpu:0, mps, cpu")
    p.add_argument("--output",   required=True,
                   help="Output WAV file path")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    seed = args.seed if args.seed >= 0 else random.randint(0, 2**31 - 1)

    # ── Import ACE-Step ───────────────────────────────────────────────────────
    try:
        from acestep.pipeline_ace_step import ACEStepPipeline
    except ImportError as e:
        error(f"acestep not installed — run: pip install git+https://github.com/ace-step/ACE-Step.git  ({e})")
        sys.exit(1)

    # ── Check checkpoint directory ────────────────────────────────────────────
    checkpoint_path = os.path.abspath(args.checkpoint_path)
    if not os.path.isdir(checkpoint_path):
        error(f"Checkpoint directory not found: {checkpoint_path}")
        sys.exit(1)

    # Check for actual weight subdirs (not transformer/ which is the old layout)
    weight_dirs = ["acestep-v15-turbo", "acestep-5Hz-lm-1.7B", "vae"]
    if not any(os.path.isdir(os.path.join(checkpoint_path, d)) for d in weight_dirs):
        info("WARNING: checkpoint appears incomplete — ACEStepPipeline may attempt HuggingFace download")

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

    # ── Load pipeline ─────────────────────────────────────────────────────────
    # ── Resolve device_id integer for pipelines that require it ──────────────
    # ACEStepPipeline.__init__ may take device_id (int) or device (str) depending
    # on version. Extract the integer index from the device string as fallback.
    device_str = args.device  # e.g. 'cuda:0', 'xpu:0', 'mps', 'cpu'
    if ':' in device_str:
        device_id_int = int(device_str.split(':')[1])
    else:
        device_id_int = 0

    info(f"Loading ACE-Step v1.5 pipeline from {checkpoint_path} (device {device_str})...")
    t0 = time.time()

    # Inspect ACEStepPipeline.__init__ to determine which device param it accepts.
    try:
        init_params = set(inspect.signature(ACEStepPipeline.__init__).parameters.keys())
    except Exception:
        init_params = set()

    pipeline_kwargs: dict = {
        "checkpoint_path": checkpoint_path,
        "dtype":           "bfloat16",
        "torch_compile":   False,
    }
    if "device_id" in init_params:
        pipeline_kwargs["device_id"] = device_id_int
    elif "device" in init_params:
        pipeline_kwargs["device"] = device_str

    try:
        pipeline = ACEStepPipeline(**pipeline_kwargs)
    except Exception as e:
        error(f"Pipeline load failed: {e}")
        sys.exit(1)

    info(f"Pipeline loaded in {time.time() - t0:.1f}s")

    # ── Inspect __call__ signature to build compatible kwargs ─────────────────
    # ACE-Step changed its API between v0.1 and v0.2. We detect what's available
    # at runtime to avoid hardcoding parameter names that may not exist.
    try:
        sig_params = set(inspect.signature(pipeline.__call__).parameters.keys())
    except Exception:
        sig_params = set()

    info(f"Generating {args.duration:.0f}s — prompt: {args.prompt[:80]}")
    t1 = time.time()

    # Base kwargs present in all known versions
    call_kwargs: dict = {
        "audio_duration": args.duration,
        "prompt":         args.prompt,
        "lyrics":         args.lyrics,
        "infer_step":     args.steps,
        "guidance_scale": args.cfg,
        "scheduler_type": "euler",
        "save_path":      os.path.dirname(args.output),
        "format":         "wav",
    }

    # Seed — v0.1 used actual_seeds=[int], v0.2 uses seed=int
    if "actual_seeds" in sig_params:
        call_kwargs["actual_seeds"] = [seed]
    elif "seed" in sig_params:
        call_kwargs["seed"] = seed

    # output_path — present in some versions, absent in others
    if "output_path" in sig_params:
        call_kwargs["output_path"] = args.output

    # ERG / CFG params — v0.1 only
    if "cfg_type" in sig_params:
        call_kwargs["cfg_type"] = "apg"
    if "omega_scale" in sig_params:
        call_kwargs["omega_scale"] = 10.0
    if "guidance_interval" in sig_params:
        call_kwargs["guidance_interval"] = 1.0
    if "guidance_interval_decay" in sig_params:
        call_kwargs["guidance_interval_decay"] = 0.0
    if "min_guidance_scale" in sig_params:
        call_kwargs["min_guidance_scale"] = 1.0
    if "use_erg_tag" in sig_params:
        call_kwargs["use_erg_tag"] = True
    if "use_erg_lyric" in sig_params:
        call_kwargs["use_erg_lyric"] = True
    if "use_erg_diffusion" in sig_params:
        call_kwargs["use_erg_diffusion"] = True
    if "oss_steps" in sig_params:
        call_kwargs["oss_steps"] = []
    if "guidance_scale_text" in sig_params:
        call_kwargs["guidance_scale_text"] = 0.0
    if "guidance_scale_lyric" in sig_params:
        call_kwargs["guidance_scale_lyric"] = 0.0

    try:
        pipeline(**call_kwargs)
    except Exception as e:
        error(f"Generation failed: {e}")
        sys.exit(1)

    # Normalise output path — some versions save to save_path/<uuid>.wav
    output_path = args.output
    if not os.path.exists(output_path):
        save_dir = os.path.dirname(output_path)
        wavs = sorted(
            [os.path.join(save_dir, f) for f in os.listdir(save_dir) if f.endswith(".wav")],
            key=os.path.getmtime,
            reverse=True,
        )
        if wavs and wavs[0] != output_path:
            os.replace(wavs[0], output_path)

    if not os.path.exists(output_path):
        error(f"Pipeline completed but output file not found: {output_path}")
        sys.exit(1)

    info(f"Generated in {time.time() - t1:.1f}s — {output_path}")
    done(output_path)


if __name__ == "__main__":
    main()