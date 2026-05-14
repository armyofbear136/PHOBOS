#!/usr/bin/env python3
"""
phobos-diffusers.py — PyTorch / HuggingFace Diffusers image generation CLI.

Spawned by ImageServerManager.ts as a child process, same pattern as sd-cli.
All parameters via CLI args. Progress output matches sd-cli format so the
existing parseProgressLine() and classifySdLine() in WorkflowEngine.ts work
unchanged.

Usage:
  python phobos-diffusers.py \
    --model-path /path/to/model.gguf \
    --model-type chroma \
    --prompt "a bear in the woods" \
    --device cuda:0 \
    --output /path/to/output.png

Supported model types: flux, chroma, sdxl, wan, qwen-image, kontext, z-image
Supported formats: GGUF (via GGUFQuantizationConfig), safetensors (single-file)
"""

import argparse
import os
import sys
import time
import json
from pathlib import Path

# ── Argument parsing ─────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="PHOBOS PyTorch image generation")

    # Model
    p.add_argument("--model-path", required=True, help="Path to diffusion model (GGUF or safetensors)")
    p.add_argument("--model-type", required=True, choices=["flux", "chroma", "sdxl", "flux2", "z-image", "kontext", "qwen-image", "wan"],
                   help="Model architecture family")
    p.add_argument("--config-repo", default=None, help="HuggingFace repo ID for model config (e.g. black-forest-labs/FLUX.1-dev)")
    p.add_argument("--config-path", default=None, help="Local path to HuggingFace config directory")

    # Aux files (FLUX/Chroma architecture)
    p.add_argument("--vae-path", default=None, help="Path to VAE safetensors")
    p.add_argument("--t5-path", default=None, help="Path to T5 encoder (GGUF or safetensors)")
    p.add_argument("--clip-path", default=None, help="Path to CLIP-L safetensors")
    p.add_argument("--llm-path", default=None, help="Path to LLM encoder GGUF (FLUX.2, Z-Image)")

    # Generation params
    p.add_argument("--prompt", required=True, help="Text prompt")
    p.add_argument("--negative-prompt", default="", help="Negative prompt")
    p.add_argument("--steps", type=int, default=20, help="Inference steps")
    p.add_argument("--width", type=int, default=1024, help="Output width")
    p.add_argument("--height", type=int, default=1024, help="Output height")
    p.add_argument("--seed", type=int, default=-1, help="Random seed (-1 = random)")
    p.add_argument("--sampler", default="euler", help="Sampling method")
    p.add_argument("--cfg-scale", type=float, default=3.5, help="Guidance/CFG scale")

    # img2img / inpaint
    p.add_argument("--init-image", default=None, help="Input image path (img2img/inpaint)")
    p.add_argument("--strength", type=float, default=None, help="Denoising strength (0-1)")
    p.add_argument("--mask-image", default=None, help="Mask path (inpaint)")

    # ControlNet
    p.add_argument("--control-image", default=None, help="ControlNet conditioning image")
    p.add_argument("--control-scale", type=float, default=None, help="ControlNet guidance scale")

    # Kontext
    p.add_argument("--ref-image", default=None, help="Reference image (Kontext editing)")

    # Video (Wan)
    p.add_argument("--num-frames", type=int, default=49, help="Number of video frames (Wan)")
    p.add_argument("--fps", type=int, default=12, help="Video frames per second (Wan)")
    p.add_argument("--flow-shift", type=float, default=3.0, help="Flow matching shift (Wan: 3.0 for 480P, 5.0 for 720P)")

    # Artist Plugin System — multi-adapter LoRA
    # Colon-delimited lists for 1–3 plugins per node.
    # --lora-kinds: 'plugin' = read lora.safetensors from .phobos zip; 'raw_lora' = flat file.
    p.add_argument("--lora-paths",   default=None, help="Colon-delimited LoRA archive/file paths")
    p.add_argument("--lora-weights", default=None, help="Colon-delimited adapter weights (0.0–1.0)")
    p.add_argument("--lora-names",   default=None, help="Colon-delimited adapter names (plugin_0, ...)")
    p.add_argument("--lora-kinds",   default=None, help="Colon-delimited kinds: 'plugin' or 'raw_lora'")

    # Device / dtype
    p.add_argument("--device", default="cuda:0", help="PyTorch device (cuda:0, xpu:0, mps, cpu)")
    p.add_argument("--dtype", default="bfloat16", choices=["float16", "bfloat16", "float32"],
                   help="Compute dtype")
    p.add_argument("--offload-cpu", action="store_true", help="Enable model CPU offload")

    # Output
    p.add_argument("--output", required=True, help="Output image path")

    # Preview
    p.add_argument("--preview-path", default=None, help="Write latent previews here")
    p.add_argument("--preview-interval", type=int, default=1, help="Steps between previews")

    # PyTorch variant (pre-converted diffusers directory)
    p.add_argument("--pytorch-variant-dir", default=None,
                   help="Path to pre-converted diffusers directory (from_pretrained). "
                        "If present and valid, used instead of from_single_file for SDXL.")

    # Performance optimisations (opt-in, CUDA Ampere+ recommended for sage)
    p.add_argument("--sage-attention", action="store_true",
                   help="Enable SageAttention 2.x attention backend (requires sageattention ≥2.1.1)")
    p.add_argument("--torch-compile", action="store_true",
                   help="Compile transformer with torch.compile reduce-overhead (first run ~2 min warm-up)")

    return p


# ── Progress output ──────────────────────────────────────────────────────────
# Matches sd-cli format so WorkflowEngine.ts parseProgressLine() works unchanged.

def log(msg: str) -> None:
    """Print a log line that classifySdLine() can parse."""
    print(msg, flush=True)

def log_progress(step: int, total: int, elapsed: float) -> None:
    """Print a progress line matching sd-cli format: '[N/M]' or 'step N/M'."""
    # sd-cli format: |=====>                | 3/20 - 2.50s/it
    # parseProgressLine matches: /\[?(\d+)\s*\/\s*(\d+)\]?/
    speed = elapsed / max(step, 1)
    unit = "s/it" if speed >= 1.0 else "it/s"
    val = speed if speed >= 1.0 else (1.0 / speed if speed > 0 else 0)
    print(f"  step {step}/{total} - {val:.2f} {unit}", flush=True)


# ── Device selection ─────────────────────────────────────────────────────────

def select_device(requested: str) -> str:
    """Validate and return the best available device."""
    import torch

    if requested.startswith("cuda"):
        if torch.cuda.is_available():
            return requested
        log(f"[WARN] CUDA requested but not available, falling back to CPU")
        return "cpu"

    if requested.startswith("xpu"):
        if hasattr(torch, "xpu") and torch.xpu.is_available():
            return requested
        log(f"[WARN] XPU requested but not available, falling back to CPU")
        return "cpu"

    if requested == "mps":
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return requested
        log(f"[WARN] MPS requested but not available, falling back to CPU")
        return "cpu"

    return "cpu"


def resolve_dtype(name: str):
    """Convert dtype string to torch dtype."""
    import torch
    return {"float16": torch.float16, "bfloat16": torch.bfloat16, "float32": torch.float32}[name]


# ── GGUF model loading ───────────────────────────────────────────────────────

def is_gguf(path: str) -> bool:
    return path.lower().endswith(".gguf")


def load_flux_gguf_pipeline(args, device: str, dtype):
    """Load a FLUX/Chroma model from GGUF with Diffusers.

    Uses model-type-specific Transformer and Pipeline classes:
    - Chroma: ChromaTransformer2DModel + ChromaPipeline (config from lodestones/Chroma1-HD)
    - FLUX:   FluxTransformer2DModel + FluxPipeline (config from city96 or bundled)

    Assembles pipeline manually from individual components.
    """
    import torch
    from diffusers import (
        FluxPipeline, FluxTransformer2DModel,
        ChromaPipeline, ChromaTransformer2DModel,
        AutoencoderKL, GGUFQuantizationConfig,
    )
    from diffusers.schedulers import FlowMatchEulerDiscreteScheduler
    from transformers import CLIPTextModel, CLIPTokenizer, T5EncoderModel, T5TokenizerFast

    is_chroma = args.model_type == "chroma"

    # ── Config source per model type ─────────────────────────────────────────
    # Each model type needs a non-gated HuggingFace repo for its config.json.
    # These are tiny JSON downloads (~500 bytes), cached permanently.
    #
    # IMPORTANT: schnell has a different transformer config (distilled, fewer layers)
    # but shares the same VAE as FLUX dev. The bundled configs/flux1-schnell/ dir
    # only contains transformer/config.json — it has no VAE config. So we track
    # transformer_config and vae_config separately.
    if is_chroma:
        transformer_config = "lodestones/Chroma1-HD"
        vae_config = "lodestones/Chroma1-HD"
        TransformerClass = ChromaTransformer2DModel
        PipelineClass = ChromaPipeline
    else:
        # VAE config always uses the full FLUX repo (has vae/ subfolder with config.json)
        vae_config = "ostris/Flex.1-alpha"

        # FLUX schnell has a different transformer architecture (distilled, fewer layers).
        # Detect by filename or explicit --config-path.
        model_lower = Path(args.model_path).name.lower()
        if "schnell" in model_lower or (args.config_path and "schnell" in args.config_path.lower()):
            # Bundled config at phobos/configs/flux1-schnell/
            script_dir = Path(__file__).parent
            bundled = script_dir / "configs" / "flux1-schnell"
            if bundled.is_dir():
                transformer_config = str(bundled)
            else:
                transformer_config = "city96/FLUX.1-schnell-gguf"
        else:
            transformer_config = "ostris/Flex.1-alpha"  # FLUX dev — Apache 2.0, not gated
        TransformerClass = FluxTransformer2DModel
        PipelineClass = FluxPipeline

    # Explicit user override always wins — applies to both configs
    if args.config_path and os.path.isdir(args.config_path):
        transformer_config = args.config_path
        vae_config = args.config_path

    # ── Load transformer from GGUF ───────────────────────────────────────────
    log(f"loading diffusion model from {Path(args.model_path).name}")

    quant_config = GGUFQuantizationConfig(compute_dtype=dtype)

    transformer = TransformerClass.from_single_file(
        args.model_path,
        quantization_config=quant_config,
        config=transformer_config,
        subfolder="transformer",
        torch_dtype=dtype,
    )
    log("loading diffusion model completed")

    # ── Load VAE ─────────────────────────────────────────────────────────────
    vae = None
    if args.vae_path and os.path.exists(args.vae_path):
        log(f"loading vae from {Path(args.vae_path).name}")
        vae = AutoencoderKL.from_single_file(
            args.vae_path,
            config=vae_config,
            subfolder="vae",
            torch_dtype=dtype,
        )
        log("loading vae completed")

    # ── Load T5 encoder ──────────────────────────────────────────────────────
    text_encoder_2 = None
    tokenizer_2 = None
    if args.t5_path:
        if is_gguf(args.t5_path):
            log(f"loading t5xxl from {Path(args.t5_path).name} (GGUF)")
            text_encoder_2 = T5EncoderModel.from_pretrained(
                os.path.dirname(args.t5_path),
                gguf_file=os.path.basename(args.t5_path),
                torch_dtype=dtype,
            )
        else:
            log(f"loading t5xxl from {Path(args.t5_path).name}")
            text_encoder_2 = T5EncoderModel.from_pretrained(
                os.path.dirname(args.t5_path),
                torch_dtype=dtype,
            )
        log("loading t5xxl completed")
        # T5 tokenizer — small, public, cached permanently
        log("loading t5 tokenizer")
        tokenizer_2 = T5TokenizerFast.from_pretrained("google/t5-v1_1-xxl", legacy=False)

    # ── Load CLIP-L encoder (FLUX.1 only, not Chroma) ────────────────────────
    text_encoder = None
    tokenizer = None
    if not is_chroma:
        if args.clip_path and os.path.exists(args.clip_path):
            log(f"loading clip from {Path(args.clip_path).name}")
            text_encoder = CLIPTextModel.from_pretrained(
                "openai/clip-vit-large-patch14",
                torch_dtype=dtype,
            )
            tokenizer = CLIPTokenizer.from_pretrained("openai/clip-vit-large-patch14")
            log("loading clip completed")
        else:
            log("loading clip from openai/clip-vit-large-patch14")
            text_encoder = CLIPTextModel.from_pretrained(
                "openai/clip-vit-large-patch14",
                torch_dtype=dtype,
            )
            tokenizer = CLIPTokenizer.from_pretrained("openai/clip-vit-large-patch14")
            log("loading clip completed")

    # ── Assemble pipeline ────────────────────────────────────────────────────
    log("loading pipeline components")

    scheduler = FlowMatchEulerDiscreteScheduler()

    pipe_kwargs = {
        "transformer": transformer,
        "scheduler": scheduler,
    }
    if vae is not None:
        pipe_kwargs["vae"] = vae

    if is_chroma:
        # ChromaPipeline: T5 is "text_encoder", no CLIP
        if text_encoder_2 is not None:
            pipe_kwargs["text_encoder"] = text_encoder_2
        if tokenizer_2 is not None:
            pipe_kwargs["tokenizer"] = tokenizer_2
    else:
        # FluxPipeline: CLIP is "text_encoder", T5 is "text_encoder_2"
        if text_encoder_2 is not None:
            pipe_kwargs["text_encoder_2"] = text_encoder_2
        if tokenizer_2 is not None:
            pipe_kwargs["tokenizer_2"] = tokenizer_2
        if text_encoder is not None:
            pipe_kwargs["text_encoder"] = text_encoder
        if tokenizer is not None:
            pipe_kwargs["tokenizer"] = tokenizer

    pipe = PipelineClass(**pipe_kwargs)

    # Memory management
    if args.offload_cpu:
        log("enabling CPU offload")
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)

    log("loading tensors completed")
    return pipe


def load_sdxl_safetensors_pipeline(args, device: str, dtype):
    """Load an SDXL model, preferring a pre-converted diffusers directory.

    Load order:
    1. If args.pytorch_variant_dir points to a valid diffusers directory
       (model_index.json present), use from_pretrained — fast, works with
       any diffusers/transformers version.
    2. Fall back to from_single_file on the raw safetensors — works on
       diffusers <0.36 / older transformers, but may fail on newer envs due
       to the CLIPTextModel break in transformers >=4.52. Users should convert
       via the "Convert to PyTorch" button in the image model settings.
    """
    from diffusers import StableDiffusionXLPipeline

    # ── Path 1: from_pretrained on converted directory ──────────────────────
    variant_dir = getattr(args, 'pytorch_variant_dir', None)
    if variant_dir and os.path.isdir(variant_dir) and os.path.exists(os.path.join(variant_dir, "model_index.json")):
        log(f"loading diffusion model from pytorch variant (from_pretrained)")
        pipe = StableDiffusionXLPipeline.from_pretrained(
            variant_dir,
            torch_dtype=dtype,
            local_files_only=True,
        )
        if args.offload_cpu:
            log("enabling CPU offload")
            pipe.enable_model_cpu_offload()
        else:
            pipe = pipe.to(device)
        log("loading tensors completed")
        return pipe

    # ── Path 2: from_single_file fallback ───────────────────────────────────
    log(f"loading diffusion model from {Path(args.model_path).name}")
    log("[WARN] Loading SDXL via from_single_file — may fail with transformers >=4.52. "
        "Convert this model via Phobos image settings for reliable loading.")

    pipe = StableDiffusionXLPipeline.from_single_file(
        args.model_path,
        torch_dtype=dtype,
    )

    if args.offload_cpu:
        log("enabling CPU offload")
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)

    log("loading tensors completed")
    return pipe


def load_wan_pipeline(args, device: str, dtype):
    """Load a Wan 2.1 T2V model from GGUF with Diffusers.

    Wan uses: WanTransformer3DModel (GGUF) + AutoencoderKLWan (float32) +
    UMT5EncoderModel (text encoder). Scheduler: UniPCMultistepScheduler.
    """
    import torch
    from diffusers import WanPipeline, WanTransformer3DModel, AutoencoderKLWan, GGUFQuantizationConfig
    from diffusers.schedulers import UniPCMultistepScheduler

    # ftfy is required by WanPipeline.__call__ for text pre-processing.
    # diffusers 0.36 does not declare it as a dependency — install it in the venv
    # via PythonEnvManager Pass 1. Import here so a missing package gives a clear
    # error at load time rather than a NameError deep inside the pipeline.
    import ftfy  # noqa: F401  — side-effect import, pipeline reads it via its own import

    config_repo = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"

    # ── Load transformer from GGUF ──────────────────────────────────────────
    log(f"loading diffusion model from {Path(args.model_path).name}")
    quant_config = GGUFQuantizationConfig(compute_dtype=dtype)
    transformer = WanTransformer3DModel.from_single_file(
        args.model_path,
        quantization_config=quant_config,
        config=config_repo,
        subfolder="transformer",
        torch_dtype=dtype,
    )
    log("loading diffusion model completed")

    # ── Load VAE (must be float32 for Wan) ──────────────────────────────────
    log("loading vae from Wan pretrained")
    vae = AutoencoderKLWan.from_pretrained(
        config_repo,
        subfolder="vae",
        torch_dtype=torch.float32,
    )
    log("loading vae completed")

    # ── Assemble pipeline ───────────────────────────────────────────────────
    log("loading pipeline components")
    pipe = WanPipeline.from_pretrained(
        config_repo,
        transformer=transformer,
        vae=vae,
        torch_dtype=dtype,
    )
    pipe.scheduler = UniPCMultistepScheduler.from_config(
        pipe.scheduler.config,
        flow_shift=args.flow_shift,
    )

    if args.offload_cpu:
        log("enabling CPU offload")
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)

    log("loading tensors completed")
    return pipe


def load_qwen_image_pipeline(args, device: str, dtype):
    """Load Qwen-Image pipeline.

    QwenImagePipeline does NOT support from_single_file(). The pipeline must be
    loaded via from_pretrained() from the HF repo. When the model path points to
    a GGUF file, we load the transformer separately via from_single_file() and
    inject it into the pretrained pipeline.

    On ≤12 GB VRAM cards, sequential CPU offload is essential.
    Config repo Qwen/Qwen-Image is not gated.
    """
    from diffusers import QwenImagePipeline, GGUFQuantizationConfig

    config_repo = "Qwen/Qwen-Image"
    log(f"loading Qwen-Image pipeline")

    if is_gguf(args.model_path):
        # Load transformer from GGUF, inject into pretrained pipeline
        log(f"loading transformer from {Path(args.model_path).name} (GGUF)")
        from diffusers import QwenImageTransformer2DModel
        quant_config = GGUFQuantizationConfig(compute_dtype=dtype)
        transformer = QwenImageTransformer2DModel.from_single_file(
            args.model_path,
            quantization_config=quant_config,
            config=config_repo,
            subfolder="transformer",
            torch_dtype=dtype,
        )
        log("loading transformer completed")

        pipe = QwenImagePipeline.from_pretrained(
            config_repo,
            transformer=transformer,
            torch_dtype=dtype,
        )
    else:
        pipe = QwenImagePipeline.from_pretrained(
            config_repo,
            torch_dtype=dtype,
        )

    if args.offload_cpu:
        log("enabling sequential CPU offload")
        pipe.enable_sequential_cpu_offload()
    else:
        pipe = pipe.to(device)

    log("loading tensors completed")
    return pipe


def load_kontext_pipeline(args, device: str, dtype):
    """Load FLUX Kontext pipeline.

    Uses FluxKontextPipeline. The official repo (black-forest-labs/FLUX.1-Kontext-dev)
    is gated — falls back to bundled config or user-provided --config-path.
    Shares FLUX.1 aux pool: VAE + CLIP-L + T5.
    """
    import torch
    from diffusers import FluxKontextPipeline, FluxTransformer2DModel, AutoencoderKL, GGUFQuantizationConfig
    from diffusers.schedulers import FlowMatchEulerDiscreteScheduler
    from transformers import CLIPTextModel, CLIPTokenizer, T5EncoderModel, T5TokenizerFast

    # Kontext uses FLUX architecture — same transformer class, different pipeline
    config_repo = args.config_path if (args.config_path and os.path.isdir(args.config_path)) else "ostris/Flex.1-alpha"

    # ── Load transformer from GGUF ──────────────────────────────────────────
    log(f"loading diffusion model from {Path(args.model_path).name}")
    quant_config = GGUFQuantizationConfig(compute_dtype=dtype)
    transformer = FluxTransformer2DModel.from_single_file(
        args.model_path,
        quantization_config=quant_config,
        config=config_repo,
        subfolder="transformer",
        torch_dtype=dtype,
    )
    log("loading diffusion model completed")

    # ── Load VAE ────────────────────────────────────────────────────────────
    vae = None
    if args.vae_path and os.path.exists(args.vae_path):
        log(f"loading vae from {Path(args.vae_path).name}")
        vae = AutoencoderKL.from_single_file(
            args.vae_path,
            config=config_repo,
            subfolder="vae",
            torch_dtype=dtype,
        )
        log("loading vae completed")

    # ── Load T5 encoder ─────────────────────────────────────────────────────
    text_encoder_2 = None
    tokenizer_2 = None
    if args.t5_path:
        if is_gguf(args.t5_path):
            log(f"loading t5xxl from {Path(args.t5_path).name} (GGUF)")
            text_encoder_2 = T5EncoderModel.from_pretrained(
                os.path.dirname(args.t5_path),
                gguf_file=os.path.basename(args.t5_path),
                torch_dtype=dtype,
            )
        else:
            log(f"loading t5xxl from {Path(args.t5_path).name}")
            text_encoder_2 = T5EncoderModel.from_pretrained(
                os.path.dirname(args.t5_path),
                torch_dtype=dtype,
            )
        log("loading t5xxl completed")
        tokenizer_2 = T5TokenizerFast.from_pretrained("google/t5-v1_1-xxl", legacy=False)

    # ── Load CLIP-L encoder ─────────────────────────────────────────────────
    log("loading clip from openai/clip-vit-large-patch14")
    text_encoder = CLIPTextModel.from_pretrained(
        "openai/clip-vit-large-patch14",
        torch_dtype=dtype,
    )
    tokenizer = CLIPTokenizer.from_pretrained("openai/clip-vit-large-patch14")
    log("loading clip completed")

    # ── Assemble pipeline ───────────────────────────────────────────────────
    log("loading pipeline components")
    scheduler = FlowMatchEulerDiscreteScheduler()
    pipe_kwargs = {
        "transformer": transformer,
        "scheduler": scheduler,
        "text_encoder": text_encoder,
        "tokenizer": tokenizer,
    }
    if vae is not None:
        pipe_kwargs["vae"] = vae
    if text_encoder_2 is not None:
        pipe_kwargs["text_encoder_2"] = text_encoder_2
    if tokenizer_2 is not None:
        pipe_kwargs["tokenizer_2"] = tokenizer_2

    pipe = FluxKontextPipeline(**pipe_kwargs)

    if args.offload_cpu:
        log("enabling CPU offload")
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)

    log("loading tensors completed")
    return pipe


def load_zimage_pipeline(args, device: str, dtype):
    """Load Z-Image pipeline by assembling components manually.

    ZImagePipeline.from_single_file() has a known bug in diffusers 0.36 where
    cap_pad_token is stored as shape (dim,) in the GGUF but the model expects
    (1, dim). This causes a ValueError on load.

    Fix: load the transformer via GGUFQuantizationConfig + from_pretrained on the
    GGUF directory (same pattern as Flux/Chroma), manually unsqueeze cap_pad_token
    after load, then assemble the pipeline from components.
    """
    try:
        from diffusers import ZImagePipeline
        from diffusers.models.transformers import ZImageTransformer2DModel
    except ImportError:
        raise ImportError(
            "ZImagePipeline not found in diffusers. "
            "Requires diffusers >= 0.36.0. Run: pip install --upgrade diffusers"
        )

    from diffusers import AutoencoderKL, GGUFQuantizationConfig
    from diffusers.schedulers import FlowMatchEulerDiscreteScheduler

    log(f"loading Z-Image pipeline from {Path(args.model_path).name}")

    quant_config = GGUFQuantizationConfig(compute_dtype=dtype)

    # ── Text encoder (Qwen3 GGUF) ────────────────────────────────────────────
    if args.llm_path:
        log(f"loading text encoder from {Path(args.llm_path).name}")
        from transformers import AutoModelForCausalLM, AutoTokenizer
        llm_dir  = os.path.dirname(args.llm_path)
        llm_file = os.path.basename(args.llm_path)
        text_encoder = AutoModelForCausalLM.from_pretrained(
            llm_dir,
            gguf_file=llm_file,
            torch_dtype=dtype,
        )
        tokenizer = AutoTokenizer.from_pretrained(
            llm_dir,
            gguf_file=llm_file,
        )
        log("loading text encoder completed")
    else:
        raise ValueError("Z-Image requires --llm-path (Qwen3 GGUF text encoder)")

    # ── Diffusion transformer (Z-Image GGUF) ─────────────────────────────────
    # Load via from_single_file with GGUFQuantizationConfig.
    # cap_pad_token is stored as (dim,) in the GGUF but model expects (1, dim).
    # Use ignore_mismatched_sizes=True to bypass the strict shape check, then
    # unsqueeze the tensor immediately after. The trained value is preserved —
    # unsqueezing doesn't change the data, only adds a batch dimension.
    log(f"loading transformer from {Path(args.model_path).name}")
    transformer = ZImageTransformer2DModel.from_single_file(
        args.model_path,
        quantization_config=quant_config,
        torch_dtype=dtype,
        low_cpu_mem_usage=False,
        ignore_mismatched_sizes=True,
    )

    # Fix cap_pad_token shape: unsqueeze to (1, dim) immediately after load.
    if hasattr(transformer, 'cap_pad_token') and transformer.cap_pad_token.ndim == 1:
        import torch
        with torch.no_grad():
            transformer.cap_pad_token.data = transformer.cap_pad_token.data.unsqueeze(0)
        log("fixed cap_pad_token shape: (dim,) → (1, dim)")

    # ── VAE ──────────────────────────────────────────────────────────────────
    vae = None
    if args.vae_path:
        log(f"loading vae from {Path(args.vae_path).name}")
        vae = AutoencoderKL.from_single_file(args.vae_path, torch_dtype=dtype)
        log("loading vae completed")

    # ── Assemble pipeline ────────────────────────────────────────────────────
    log("loading pipeline components")
    scheduler = FlowMatchEulerDiscreteScheduler()
    pipe = ZImagePipeline(
        scheduler=scheduler,
        vae=vae,
        text_encoder=text_encoder,
        tokenizer=tokenizer,
        transformer=transformer,
    )

    if args.offload_cpu:
        log("enabling CPU offload")
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)

    log("loading tensors completed")
    return pipe

def load_pipeline(args, device: str, dtype):
    """Load the appropriate pipeline based on model type and format."""
    model_type = args.model_type

    if model_type in ("flux", "chroma"):
        if is_gguf(args.model_path):
            return load_flux_gguf_pipeline(args, device, dtype)
        else:
            # safetensors single-file — same pipeline, different loader
            from diffusers import FluxPipeline
            log(f"loading diffusion model from {Path(args.model_path).name}")
            pipe = FluxPipeline.from_single_file(
                args.model_path, torch_dtype=dtype,
            )
            if args.offload_cpu:
                pipe.enable_model_cpu_offload()
            else:
                pipe = pipe.to(device)
            log("loading tensors completed")
            return pipe

    if model_type == "sdxl":
        return load_sdxl_safetensors_pipeline(args, device, dtype)

    if model_type == "wan":
        return load_wan_pipeline(args, device, dtype)

    if model_type == "qwen-image":
        return load_qwen_image_pipeline(args, device, dtype)

    if model_type == "kontext":
        return load_kontext_pipeline(args, device, dtype)

    if model_type == "z-image":
        return load_zimage_pipeline(args, device, dtype)

    raise ValueError(f"Unsupported model type: {model_type}")


# ── Post-load optimisations ───────────────────────────────────────────────────

# Models where SageAttention is known to produce broken output.
# Z-Image: produces black images. Quantised Wan: NaN in query tensors.
_SAGE_BLOCKED_TYPES: frozenset = frozenset({"z-image"})


def _is_wan_quantised(args) -> bool:
    """True when the active model is a quantised (GGUF) Wan checkpoint."""
    return args.model_type == "wan" and is_gguf(args.model_path)


def apply_optimizations(pipe, args, device: str) -> None:
    """Apply SageAttention and/or torch.compile after pipeline load.

    Both are opt-in via CLI flags. Neither raises on failure — a warning is
    logged and generation continues with the default attention backend.
    """
    if args.sage_attention:
        _apply_sage_attention(pipe, args, device)
    if args.torch_compile:
        _apply_torch_compile(pipe, args)


def _apply_sage_attention(pipe, args, device: str) -> None:
    """Set SageAttention 2.x as the attention backend.

    Diffusers 0.36 reads DIFFUSERS_ATTN_BACKEND at the start of each
    attention forward() call — setting it here after load is safe and
    affects all subsequent inference steps.
    """
    import importlib.util

    if args.model_type in _SAGE_BLOCKED_TYPES:
        log(f"[INFO ] SageAttention skipped — not supported for model type '{args.model_type}'")
        return

    if _is_wan_quantised(args):
        log("[INFO ] SageAttention skipped — quantised Wan model (NaN risk in query tensors)")
        return

    if not (device.startswith("cuda") or device.startswith("rocm")):
        log(f"[INFO ] SageAttention skipped — not supported on device '{device}'")
        return

    if importlib.util.find_spec("sageattention") is None:
        log("[WARN] --sage-attention set but sageattention package not installed — skipping")
        return

    try:
        import sageattention
        from packaging.version import Version

        raw_ver = getattr(sageattention, "__version__", None)
        if raw_ver is not None and Version(raw_ver) < Version("2.1.1"):
            log(f"[WARN] SageAttention {raw_ver} < 2.1.1 required — skipping")
            return

        os.environ["DIFFUSERS_ATTN_BACKEND"] = "sage_attn"
        ver_str = raw_ver if raw_ver else "unknown version"
        log(f"[INFO ] SageAttention {ver_str} enabled")

    except Exception as e:
        log(f"[WARN] SageAttention setup failed — falling back to SDPA: {e}")


def _apply_torch_compile(pipe, args) -> None:
    """Compile the diffusion transformer with torch.compile reduce-overhead.

    Traces the graph once and emits CUDA graphs for subsequent steps.
    Cache lives in ~/.triton/cache/ — reused across runs for the same model.

    Skipped on non-CUDA (no Triton backend) and Wan video (dynamic latent
    shapes change per call, causing retrace on every denoising step).
    Skipped when --offload-cpu is set — torch.compile and CPU offload are
    incompatible in PyTorch <2.5; guard kept for correctness on all versions.
    """
    import torch

    if args.model_type == "wan":
        log("[INFO ] torch.compile skipped — Wan video uses dynamic latent shapes")
        return

    if args.offload_cpu:
        log("[INFO ] torch.compile skipped — incompatible with --offload-cpu")
        return

    if not torch.cuda.is_available():
        log("[INFO ] torch.compile skipped — requires CUDA")
        return

    # ROCm on Windows: triton-windows is CUDA-only. torch.compile calls the
    # Triton backend which has no Windows ROCm support — it raises a
    # TorchDynamo error immediately. Detect via torch.version.hip (only set
    # on ROCm builds) + sys.platform.
    import sys
    if sys.platform == "win32" and getattr(torch.version, "hip", None) is not None:
        log("[INFO ] torch.compile skipped — Triton has no ROCm Windows backend")
        return

    transformer = getattr(pipe, "transformer", None) or getattr(pipe, "unet", None)
    if transformer is None:
        log("[WARN] torch.compile: no transformer/unet found on pipeline — skipping")
        return

    try:
        log("[INFO ] torch.compile: compiling transformer (first run ~2 min, cached after)…")
        compiled = torch.compile(transformer, mode="reduce-overhead", fullgraph=False)
        if hasattr(pipe, "transformer"):
            pipe.transformer = compiled
        else:
            pipe.unet = compiled
        log("[INFO ] torch.compile: ready")
    except Exception as e:
        log(f"[WARN] torch.compile failed — running uncompiled: {e}")


# ── Callback for step progress ───────────────────────────────────────────────

class ProgressCallback:
    """Diffusers callback that emits sd-cli-compatible progress lines."""

    def __init__(self, total_steps: int, preview_path: str = None, preview_interval: int = 1,
                 model_type: str = "flux"):
        self.total_steps = total_steps
        self.preview_path = preview_path
        self.preview_interval = preview_interval
        self.model_type = model_type
        self.start_time = time.time()
        self.step_count = 0
        self._preview_error_logged = False

    def __call__(self, pipe, step: int, timestep, callback_kwargs):
        self.step_count = step + 1  # Diffusers uses 0-based steps
        elapsed = time.time() - self.start_time
        log_progress(self.step_count, self.total_steps, elapsed)

        if self.preview_path and self.step_count % self.preview_interval == 0:
            latents = callback_kwargs.get("latents")
            if latents is not None:
                self._write_preview(latents)

        return callback_kwargs

    def _write_preview(self, latents):
        """Project latents to a preview image and write to disk.

        Strategy by model family:
        - FLUX / Chroma / Z-Image / Kontext / FLUX2 / Qwen-Image:
            Linear channel projection — no VAE decode. Takes first 3 of the 16
            latent channels, normalises per-channel to [0,1], saves as RGB.
            Same concept as sd-cli --preview proj. Zero VRAM impact.
        - SDXL:
            Same projection on 4-channel latents, drop ch3.
        - Wan (video):
            Skipped — 5D latents, not useful as a still frame.
        """
        import torch
        from PIL import Image

        try:
            mt = self.model_type

            if mt == "wan":
                return

            t = latents.detach().float().cpu()

            if mt in ("flux", "chroma", "z-image", "kontext", "flux2", "qwen-image"):
                # FLUX-family: (B, 16, H, W) after scheduler step
                if t.ndim != 4 or t.shape[1] < 3:
                    return
                rgb = t[0, :3].clone()                      # (3, H, W)
            elif mt == "sdxl":
                # SDXL: (B, 4, H, W)
                if t.ndim != 4 or t.shape[1] < 3:
                    return
                rgb = t[0, :3].clone()                      # (3, H, W)
            else:
                return

            # Normalise each channel independently to [0, 1]
            for i in range(3):
                lo, hi = rgb[i].min(), rgb[i].max()
                rgb[i] = (rgb[i] - lo) / (hi - lo + 1e-6)

            img_arr = (rgb.permute(1, 2, 0).numpy() * 255).clip(0, 255).astype("uint8")
            Image.fromarray(img_arr).save(self.preview_path)

        except Exception as e:
            # Log the first failure so it appears in the console and is diagnosable.
            # Subsequent steps stay silent to avoid log spam.
            if not self._preview_error_logged:
                self._preview_error_logged = True
                log(f"[WARN] preview write failed (will not retry): {e}")


# ── Generation ───────────────────────────────────────────────────────────────

def generate_txt2img(pipe, args, device: str, dtype):
    """Run txt2img generation with the loaded pipeline."""
    import torch

    seed = args.seed if args.seed >= 0 else torch.randint(0, 2**32, (1,)).item()
    generator = torch.Generator(device="cpu").manual_seed(seed)

    log(f"generating image: seed {seed}")

    # Build generation kwargs
    gen_kwargs = {
        "prompt": args.prompt,
        "num_inference_steps": args.steps,
        "width": args.width,
        "height": args.height,
        "generator": generator,
    }

    # Model-type-specific params
    model_type = args.model_type

    if model_type == "chroma":
        gen_kwargs["guidance_scale"] = 0.0  # unconditional
    elif model_type in ("flux", "kontext"):
        gen_kwargs["guidance_scale"] = args.cfg_scale
    elif model_type == "sdxl":
        gen_kwargs["guidance_scale"] = args.cfg_scale
        if args.negative_prompt:
            gen_kwargs["negative_prompt"] = args.negative_prompt
    elif model_type == "z-image":
        gen_kwargs["guidance_scale"] = args.cfg_scale if args.cfg_scale != 3.5 else 1.0
    elif model_type == "qwen-image":
        gen_kwargs["guidance_scale"] = args.cfg_scale if args.cfg_scale != 3.5 else 2.5

    # Progress callback
    callback = ProgressCallback(
        total_steps=args.steps,
        preview_path=args.preview_path,
        preview_interval=args.preview_interval,
        model_type=args.model_type,
    )
    gen_kwargs["callback_on_step_end"] = callback

    # Artist Plugin System — multi-adapter loading
    if args.lora_paths:
        import zipfile
        import io as _io

        raw_paths   = args.lora_paths.split(":")
        raw_weights = [float(w) for w in args.lora_weights.split(":")] if args.lora_weights else [0.8] * len(raw_paths)
        raw_names   = args.lora_names.split(":") if args.lora_names else [f"plugin_{i}" for i in range(len(raw_paths))]
        raw_kinds   = args.lora_kinds.split(":") if args.lora_kinds else ["raw_lora"] * len(raw_paths)

        loaded_names   = []
        loaded_weights = []

        for archive_path, weight, adapter_name, kind in zip(raw_paths, raw_weights, raw_names, raw_kinds):
            log(f"loading plugin '{adapter_name}' from {Path(archive_path).name} (weight={weight})")
            try:
                if kind == "plugin":
                    # Read lora.safetensors directly from .phobos zip — no extraction to disk
                    with zipfile.ZipFile(archive_path, "r") as zf:
                        if "lora.safetensors" not in zf.namelist():
                            raise ValueError(f"lora.safetensors not found inside {archive_path}")
                        lora_bytes = zf.read("lora.safetensors")
                    lora_buf = _io.BytesIO(lora_bytes)
                    pipe.load_lora_weights(lora_buf, adapter_name=adapter_name)
                else:
                    # raw_lora — flat file path
                    pipe.load_lora_weights(archive_path, adapter_name=adapter_name)

                loaded_names.append(adapter_name)
                loaded_weights.append(weight)
                log(f"plugin '{adapter_name}' loaded")
            except Exception as e:
                # Non-fatal — log and skip. Degraded generation beats a crash.
                log(f"[WARN] failed to load plugin '{adapter_name}': {e}")

        if loaded_names:
            pipe.set_adapters(loaded_names, adapter_weights=loaded_weights)
            log(f"adapters active: {loaded_names} weights={loaded_weights}")

    # Kontext reference image
    if args.ref_image and model_type == "kontext":
        from PIL import Image as PILImage
        ref = PILImage.open(args.ref_image).convert("RGB")
        gen_kwargs["image"] = ref

    start = time.time()
    result = pipe(**gen_kwargs)
    elapsed = time.time() - start

    image = result.images[0]

    # Ensure output directory exists
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    image.save(args.output)

    log(f"sampling completed, taking {elapsed:.1f}s")
    log(f"Image saved to {args.output}")

    return seed, elapsed


def generate_img2img(pipe, args, device: str, dtype):
    """Run img2img generation."""
    import torch
    from PIL import Image

    seed = args.seed if args.seed >= 0 else torch.randint(0, 2**32, (1,)).item()
    generator = torch.Generator(device="cpu").manual_seed(seed)

    init_image = Image.open(args.init_image).convert("RGB")
    if args.width and args.height:
        init_image = init_image.resize((args.width, args.height))

    log(f"generating image: seed {seed} (img2img, strength={args.strength})")

    gen_kwargs = {
        "prompt": args.prompt,
        "image": init_image,
        "strength": args.strength if args.strength is not None else 0.8,
        "num_inference_steps": args.steps,
        "generator": generator,
    }

    model_type = args.model_type
    if model_type == "chroma":
        gen_kwargs["guidance_scale"] = 0.0
    elif model_type == "sdxl":
        gen_kwargs["guidance_scale"] = args.cfg_scale
        if args.negative_prompt:
            gen_kwargs["negative_prompt"] = args.negative_prompt
    else:
        gen_kwargs["guidance_scale"] = args.cfg_scale

    # Actual steps for progress = round(steps * strength)
    actual_steps = max(1, round(args.steps * (args.strength or 0.8)))
    callback = ProgressCallback(total_steps=actual_steps, preview_path=args.preview_path, preview_interval=args.preview_interval, model_type=args.model_type)
    gen_kwargs["callback_on_step_end"] = callback

    start = time.time()
    result = pipe(**gen_kwargs)
    elapsed = time.time() - start

    image = result.images[0]
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    image.save(args.output)

    log(f"sampling completed, taking {elapsed:.1f}s")
    log(f"Image saved to {args.output}")
    return seed, elapsed


def generate_video(pipe, args, device: str, dtype):
    """Run video generation (Wan T2V)."""
    import torch

    seed = args.seed if args.seed >= 0 else torch.randint(0, 2**32, (1,)).item()
    generator = torch.Generator(device="cpu").manual_seed(seed)

    log(f"generating video: seed {seed}, {args.num_frames} frames @ {args.fps} fps")

    gen_kwargs = {
        "prompt": args.prompt,
        "num_inference_steps": args.steps,
        "width": args.width,
        "height": args.height,
        "num_frames": args.num_frames,
        "generator": generator,
        "guidance_scale": args.cfg_scale if args.cfg_scale != 3.5 else 5.0,
    }

    if args.negative_prompt:
        gen_kwargs["negative_prompt"] = args.negative_prompt

    callback = ProgressCallback(total_steps=args.steps, model_type=args.model_type)
    gen_kwargs["callback_on_step_end"] = callback

    start = time.time()
    result = pipe(**gen_kwargs)
    elapsed = time.time() - start

    # Export video frames to file
    output_path = args.output
    # Ensure .mp4 extension
    if not output_path.lower().endswith(".mp4"):
        output_path = os.path.splitext(output_path)[0] + ".mp4"

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    # export_to_video requires opencv — fall back to PIL if not installed
    frames = result.frames[0]
    try:
        from diffusers.utils import export_to_video
        export_to_video(frames, output_path, fps=args.fps)
    except ImportError:
        log("[WARN] OpenCV not found — using PIL for frame export")
        import torch as _torch
        import numpy as np
        from PIL import Image as PILImage
        # Save frames as individual PNGs (most reliable fallback)
        stem = os.path.splitext(output_path)[0]
        for i, frame in enumerate(frames):
            # Frames can be: torch.Tensor, np.ndarray, or PIL.Image
            if isinstance(frame, _torch.Tensor):
                # Shape: (C, H, W) or (H, W, C), range [0,1] or [0,255]
                arr = frame.cpu().float().numpy()
                if arr.ndim == 3 and arr.shape[0] in (1, 3, 4):
                    arr = np.transpose(arr, (1, 2, 0))  # CHW → HWC
                if arr.max() <= 1.0:
                    arr = (arr * 255).clip(0, 255)
                PILImage.fromarray(arr.astype(np.uint8)).save(f"{stem}-frame{i:04d}.png")
            elif isinstance(frame, np.ndarray):
                if frame.max() <= 1.0 and frame.dtype in (np.float32, np.float64):
                    frame = (frame * 255).clip(0, 255).astype(np.uint8)
                elif frame.dtype != np.uint8:
                    frame = frame.clip(0, 255).astype(np.uint8)
                PILImage.fromarray(frame).save(f"{stem}-frame{i:04d}.png")
            else:
                # Assume PIL Image
                frame.save(f"{stem}-frame{i:04d}.png")
        # Point output_path to first frame for verification
        output_path = f"{stem}-frame0000.png"
        log(f"[WARN] Saved {len(frames)} frames as PNG (install opencv-python-headless for .mp4 export)")

    log(f"sampling completed, taking {elapsed:.1f}s")
    log(f"Video saved to {output_path}")
    return seed, elapsed


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = build_parser()
    args = parser.parse_args()

    # ── HuggingFace cache configuration ──────────────────────────────────────
    # Store HF configs alongside PHOBOS models to avoid repeated network hits.
    # After first download, set HF_HUB_OFFLINE=1 so all subsequent runs are
    # fully local — eliminates the "unauthenticated requests" warning and the
    # network round-trip on every generation.
    phobos_home = os.path.join(os.path.expanduser("~"), ".phobos")
    hf_cache = os.path.join(phobos_home, "hf-cache")
    os.makedirs(hf_cache, exist_ok=True)
    os.environ.setdefault("HF_HOME", hf_cache)
    os.environ.setdefault("TRANSFORMERS_CACHE", os.path.join(hf_cache, "transformers"))
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    # Suppress the unauthenticated HF Hub warning — PHOBOS uses cached configs only
    os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")

    # Resolve device
    import torch
    device = select_device(args.device)
    dtype = resolve_dtype(args.dtype)
    log(f"[INFO ] Device: {device}, dtype: {args.dtype}")

    # ── XPU fp64 workaround ───────────────────────────────────────────────────
    # Intel Arc (Alchemist/Xe-HPG) does not support fp64 in hardware.
    # Diffusers' RoPE embedding path calls torch.arange(..., dtype=float64) which
    # crashes with "Required aspect fp64 is not supported on the device".
    # Patch torch.arange to silently downcast float64 → float32 on XPU devices.
    if device.startswith("xpu"):
        _original_arange = torch.arange
        def _xpu_safe_arange(*args, **kwargs):
            if kwargs.get("dtype") == torch.float64:
                kwargs["dtype"] = torch.float32
            return _original_arange(*args, **kwargs)
        torch.arange = _xpu_safe_arange
        log("[INFO ] XPU: fp64->fp32 arange patch applied (Arc fp64 workaround)")

    # Load pipeline
    load_start = time.time()
    pipe = load_pipeline(args, device, dtype)
    load_elapsed = time.time() - load_start
    log(f"[INFO ] Model loaded in {load_elapsed:.1f}s")

    # Apply post-load optimisations (sage attention, torch.compile)
    apply_optimizations(pipe, args, device)

    # Generate
    if args.model_type == "wan":
        seed, gen_elapsed = generate_video(pipe, args, device, dtype)
    elif args.init_image:
        seed, gen_elapsed = generate_img2img(pipe, args, device, dtype)
    else:
        seed, gen_elapsed = generate_txt2img(pipe, args, device, dtype)

    # Verify output — check original path, .mp4 variant, and PNG frame fallback for video
    output_exists = os.path.exists(args.output)
    if not output_exists and args.model_type == "wan":
        mp4_path = os.path.splitext(args.output)[0] + ".mp4"
        png_fallback = os.path.splitext(mp4_path)[0] + "-frame0000.png"
        output_exists = os.path.exists(mp4_path) or os.path.exists(png_fallback)
    if not output_exists:
        log("[ERROR] Generation completed but output file not found")
        sys.exit(1)

    log(f"[INFO ] Done — seed {seed}, {gen_elapsed:.1f}s generation, {load_elapsed:.1f}s load")


if __name__ == "__main__":
    main()
