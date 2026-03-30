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

Supported model types: flux, chroma, sdxl
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
    p.add_argument("--model-type", required=True, choices=["flux", "chroma", "sdxl", "flux2", "z-image", "kontext", "qwen-image"],
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

    # LoRA
    p.add_argument("--lora-path", default=None, help="Path to LoRA weights")
    p.add_argument("--lora-scale", type=float, default=1.0, help="LoRA influence (0-1)")

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

    Assembles the pipeline manually from individual components to avoid
    hitting gated HuggingFace repos. All configs are bundled locally.
    """
    import torch
    from diffusers import FluxPipeline, FluxTransformer2DModel, AutoencoderKL, GGUFQuantizationConfig
    from diffusers.schedulers import FlowMatchEulerDiscreteScheduler
    from transformers import CLIPTextModel, CLIPTokenizer, T5EncoderModel, T5TokenizerFast

    # ── Resolve bundled config path ──────────────────────────────────────────
    # The config.json sits next to phobos-diffusers.py in configs/flux-transformer/
    script_dir = Path(__file__).parent
    transformer_config_dir = script_dir / "configs" / "flux-transformer"

    if args.config_path and os.path.isdir(args.config_path):
        transformer_config_dir = Path(args.config_path)

    if not (transformer_config_dir / "config.json").exists():
        raise FileNotFoundError(
            f"Transformer config not found at {transformer_config_dir / 'config.json'}. "
            "Ensure phobos/configs/flux-transformer/config.json exists."
        )

    # ── Load transformer from GGUF ───────────────────────────────────────────
    log(f"loading diffusion model from {Path(args.model_path).name}")

    quant_config = GGUFQuantizationConfig(compute_dtype=dtype)

    # Set offline mode to prevent any HuggingFace network calls during loading.
    # Diffusers should auto-detect the architecture from GGUF metadata.
    os.environ["HF_HUB_OFFLINE"] = "1"

    transformer = FluxTransformer2DModel.from_single_file(
        args.model_path,
        quantization_config=quant_config,
        torch_dtype=dtype,
    )

    # Restore online mode for subsequent downloads (tokenizers etc)
    del os.environ["HF_HUB_OFFLINE"]
    log("loading diffusion model completed")

    # ── Load VAE ─────────────────────────────────────────────────────────────
    vae = None
    if args.vae_path and os.path.exists(args.vae_path):
        log(f"loading vae from {Path(args.vae_path).name}")
        vae = AutoencoderKL.from_single_file(
            args.vae_path,
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
        # T5 tokenizer — download from HuggingFace (small, not gated)
        log("loading t5 tokenizer")
        tokenizer_2 = T5TokenizerFast.from_pretrained("google/t5-v1_1-xxl", legacy=False)

    # ── Load CLIP-L encoder (FLUX.1, not Chroma) ────────────────────────────
    text_encoder = None
    tokenizer = None
    if args.clip_path and os.path.exists(args.clip_path):
        log(f"loading clip from {Path(args.clip_path).name}")
        # CLIP-L is a safetensors file — load the model and tokenizer
        text_encoder = CLIPTextModel.from_pretrained(
            "openai/clip-vit-large-patch14",
            torch_dtype=dtype,
        )
        tokenizer = CLIPTokenizer.from_pretrained("openai/clip-vit-large-patch14")
        log("loading clip completed")
    elif args.model_type != "chroma":
        # Non-Chroma FLUX needs CLIP-L — try loading from HuggingFace
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
        "torch_dtype": dtype,
    }
    if vae is not None:
        pipe_kwargs["vae"] = vae
    if text_encoder_2 is not None:
        pipe_kwargs["text_encoder_2"] = text_encoder_2
    if tokenizer_2 is not None:
        pipe_kwargs["tokenizer_2"] = tokenizer_2
    if text_encoder is not None:
        pipe_kwargs["text_encoder"] = text_encoder
    if tokenizer is not None:
        pipe_kwargs["tokenizer"] = tokenizer

    pipe = FluxPipeline(**pipe_kwargs)

    # Memory management
    if args.offload_cpu:
        log("enabling CPU offload")
        pipe.enable_model_cpu_offload()
    else:
        pipe = pipe.to(device)

    log("loading tensors completed")
    return pipe


def load_sdxl_safetensors_pipeline(args, device: str, dtype):
    """Load an SDXL model from single-file safetensors."""
    from diffusers import StableDiffusionXLPipeline

    log(f"loading diffusion model from {Path(args.model_path).name}")

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


# ── Pipeline loading dispatch ────────────────────────────────────────────────

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

    raise ValueError(f"Unsupported model type: {model_type}")


# ── Callback for step progress ───────────────────────────────────────────────

class ProgressCallback:
    """Diffusers callback that emits sd-cli-compatible progress lines."""

    def __init__(self, total_steps: int, preview_path: str = None, preview_interval: int = 1):
        self.total_steps = total_steps
        self.preview_path = preview_path
        self.preview_interval = preview_interval
        self.start_time = time.time()
        self.step_count = 0

    def __call__(self, pipe, step: int, timestep, callback_kwargs):
        self.step_count = step + 1  # Diffusers uses 0-based steps
        elapsed = time.time() - self.start_time
        log_progress(self.step_count, self.total_steps, elapsed)

        # Latent preview — decode current latents and write to disk
        if self.preview_path and self.step_count % self.preview_interval == 0:
            try:
                latents = callback_kwargs.get("latents")
                if latents is not None:
                    self._write_preview(pipe, latents)
            except Exception:
                pass  # preview failure is never fatal

        return callback_kwargs

    def _write_preview(self, pipe, latents):
        """Decode latents to a small preview image and write to disk."""
        import torch
        from PIL import Image

        with torch.no_grad():
            # Use the VAE to decode — this is expensive, so only if requested
            decoded = pipe.vae.decode(latents / pipe.vae.config.scaling_factor, return_dict=False)[0]
            decoded = (decoded / 2 + 0.5).clamp(0, 1)
            # Convert to PIL
            image = decoded[0].cpu().permute(1, 2, 0).float().numpy()
            image = (image * 255).round().astype("uint8")
            Image.fromarray(image).save(self.preview_path)


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
    elif model_type in ("flux",):
        gen_kwargs["guidance_scale"] = args.cfg_scale
    elif model_type == "sdxl":
        gen_kwargs["guidance_scale"] = args.cfg_scale
        if args.negative_prompt:
            gen_kwargs["negative_prompt"] = args.negative_prompt

    # Progress callback
    callback = ProgressCallback(
        total_steps=args.steps,
        preview_path=args.preview_path,
        preview_interval=args.preview_interval,
    )
    gen_kwargs["callback_on_step_end"] = callback

    # LoRA
    if args.lora_path:
        log(f"loading LoRA from {Path(args.lora_path).name}")
        pipe.load_lora_weights(args.lora_path)
        if args.lora_scale != 1.0:
            pipe.fuse_lora(lora_scale=args.lora_scale)
        log("LoRA loaded")

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
    callback = ProgressCallback(total_steps=actual_steps, preview_path=args.preview_path, preview_interval=args.preview_interval)
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


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = build_parser()
    args = parser.parse_args()

    # Resolve device
    import torch
    device = select_device(args.device)
    dtype = resolve_dtype(args.dtype)
    log(f"[INFO ] Device: {device}, dtype: {args.dtype}")

    # Load pipeline
    load_start = time.time()
    pipe = load_pipeline(args, device, dtype)
    load_elapsed = time.time() - load_start
    log(f"[INFO ] Model loaded in {load_elapsed:.1f}s")

    # Generate
    if args.init_image:
        seed, gen_elapsed = generate_img2img(pipe, args, device, dtype)
    else:
        seed, gen_elapsed = generate_txt2img(pipe, args, device, dtype)

    # Verify output
    if not os.path.exists(args.output):
        log("[ERROR] Generation completed but output file not found")
        sys.exit(1)

    log(f"[INFO ] Done — seed {seed}, {gen_elapsed:.1f}s generation, {load_elapsed:.1f}s load")


if __name__ == "__main__":
    main()
