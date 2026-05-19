"""
phobos-convert.py — one-time PyTorch variant converter

Converts a monolithic GGUF or single-file safetensors model into the native
diffusers format (from_pretrained compatible) that can be loaded without
from_single_file, bypassing the GGUF dequantization step on every load.

For whole-pipeline models (SDXL): saves the full pipeline directory.
For transformer-only models (FLUX, Chroma, Wan, Qwen-Image, Z-Image, Kontext):
  saves only the transformer component. The pipeline loader assembles the rest
  from existing aux files (VAE, T5, CLIP-L) which are already BF16 safetensors
  and load fast without dequantization.

Output:
  SDXL:         <output-dir>/<model-id>/               (full pipeline)
  All others:   <output-dir>/<model-id>/transformer/   (transformer only)

Progress: emitted to stdout as JSON lines { "phase", "pct", "label" }
Errors:   emitted to stdout as { "phase": "error", "message" }

Supported model types: sdxl, flux, chroma, kontext, wan, qwen-image, z-image
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

MODEL_TYPES = ["sdxl", "flux", "chroma", "kontext", "wan", "qwen-image", "z-image"]

def parse_args():
    p = argparse.ArgumentParser(description="Convert image model to PyTorch diffusers format")
    p.add_argument("--model-path",  required=True,
                   help="Source model file (.gguf or .safetensors)")
    p.add_argument("--model-type",  required=True, choices=MODEL_TYPES,
                   help="Model architecture")
    p.add_argument("--model-id",    required=True,
                   help="Phobos model ID (used as output directory name)")
    p.add_argument("--output-dir",  required=True,
                   help="Root output directory")
    p.add_argument("--config-path", default=None,
                   help="Local config directory or HF repo override")
    p.add_argument("--dtype",       default="bfloat16",
                   choices=["bfloat16", "float16", "float32"])
    return p.parse_args()


# ── Shared helpers ────────────────────────────────────────────────────────────

def dtype_torch(dtype_str: str):
    import torch
    return {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}[dtype_str]


def _already_converted(out_dir: str, transformer_only: bool) -> bool:
    if transformer_only:
        return os.path.exists(os.path.join(out_dir, "transformer", "config.json"))
    return os.path.exists(os.path.join(out_dir, "model_index.json"))


def _free_memory():
    try:
        import torch, gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _materialize_and_save_transformer(transformer, out_dir: str, dtype, t0: float,
                                       config_repo: str | None = None,
                                       config_subfolder: str = "transformer"):
    """
    Dequantize all GGUF weights to BF16 and save as a standard diffusers
    transformer directory (config.json + diffusion_pytorch_model*.safetensors).

    Why we bypass save_pretrained():
    GGUFQuantizationConfig stores an hf_quantizer on the model object that
    save_pretrained() checks before writing — if hf_quantizer is set, it
    raises ValueError regardless of actual parameter dtypes. There is no
    supported way to clear it short of patching private attributes.

    Instead we:
      1. Pull state_dict() — this triggers the GGUF dequant kernels, producing
         real BF16 tensors for every weight.
      2. Cast any remaining non-target-dtype tensors explicitly.
      3. Write the config JSON and shard the state dict ourselves using
         safetensors.torch.save_file, exactly as save_pretrained() would.
    """
    import torch
    import json
    import math
    from safetensors.torch import save_file

    transformer_dir = os.path.join(out_dir, "transformer")
    os.makedirs(transformer_dir, exist_ok=True)

    emit("saving", 0.45, "Extracting state dict (triggers GGUF dequant — uses peak RAM) ...")

    # state_dict() calls each module's forward-dequant path, returning real tensors.
    # Cast everything to the target dtype; skip integer/bool metadata tensors.
    INT_DTYPES = {torch.bool, torch.int8, torch.int16, torch.int32, torch.int64}
    state_dict = {}
    for k, v in transformer.state_dict().items():
        if v.dtype in INT_DTYPES:
            state_dict[k] = v.contiguous()
        else:
            state_dict[k] = v.to(dtype).contiguous()

    emit("saving", 0.65, f"Sharding and writing safetensors to {transformer_dir} ...")

    # Shard at 4 GB (same default as diffusers save_pretrained).
    MAX_SHARD_BYTES = 4 * 1024 ** 3
    shards: list[dict] = [{}]
    shard_sizes = [0]
    for key, tensor in state_dict.items():
        nbytes = tensor.nbytes
        if shard_sizes[-1] + nbytes > MAX_SHARD_BYTES and shard_sizes[-1] > 0:
            shards.append({})
            shard_sizes.append(0)
        shards[-1][key] = tensor
        shard_sizes[-1] += nbytes

    if len(shards) == 1:
        # Single file — simple case.
        out_path = os.path.join(transformer_dir, "diffusion_pytorch_model.safetensors")
        save_file(shards[0], out_path, metadata={"format": "pt"})
    else:
        # Multi-shard — write index JSON matching the diffusers convention.
        n = len(shards)
        index: dict = {"metadata": {"total_size": sum(shard_sizes)}, "weight_map": {}}
        for i, shard in enumerate(shards):
            fname = f"diffusion_pytorch_model-{i+1:05d}-of-{n:05d}.safetensors"
            fpath = os.path.join(transformer_dir, fname)
            save_file(shard, fpath, metadata={"format": "pt"})
            for k in shard:
                index["weight_map"][k] = fname
        index_path = os.path.join(transformer_dir, "diffusion_pytorch_model.safetensors.index.json")
        with open(index_path, "w") as f:
            json.dump(index, f, indent=2)

    # Save config.json — fetch from HF repo (authoritative source unaffected by
    # quantization state), then patch any fields whose values differ from the
    # actual saved weights. The HF config for some GGUF variants (e.g. Chroma1-HD)
    # contains incorrect shape values that cause from_pretrained to fail.
    config_saved = False
    config_path_out = os.path.join(transformer_dir, "config.json")
    if config_repo:
        try:
            from huggingface_hub import hf_hub_download
            config_file = hf_hub_download(
                repo_id=config_repo,
                filename="config.json",
                subfolder=config_subfolder,
            )
            import shutil as _shutil
            _shutil.copy(config_file, config_path_out)
            config_saved = True
            emit("saving", 0.90, f"Config saved from {config_repo}/{config_subfolder}/config.json")
        except Exception as e:
            emit("saving", 0.90, f"Warning: could not fetch config from {config_repo}: {e} — falling back")
    if not config_saved:
        config = transformer.config.to_dict() if hasattr(transformer.config, "to_dict") else {}
        config.pop("quantization_config", None)
        config.pop("_pre_quantization_dtype", None)
        with open(config_path_out, "w") as f:
            json.dump(config, f, indent=2)

    # Patch config fields against actual weight shapes. The HF repo config may
    # be stale or simply wrong for a specific GGUF variant. Weights are always
    # authoritative. state_dict is still in memory here so no disk re-read needed.
    try:
        with open(config_path_out) as f:
            cfg = json.load(f)
        patched = False

        # context_embedder.weight shape: [hidden_size, joint_attention_dim]
        # HF config for Chroma1-HD says 4096 but the GGUF weights use 8192.
        if "context_embedder.weight" in state_dict:
            actual_jad = state_dict["context_embedder.weight"].shape[1]
            for key in ("joint_attention_dim", "context_in_dim"):
                if key in cfg and cfg[key] != actual_jad:
                    cfg[key] = actual_jad
                    patched = True

        # distilled_guidance_layer.in_proj.weight: [approximator_hidden_dim, in_channels]
        if "distilled_guidance_layer.in_proj.weight" in state_dict:
            in_proj = state_dict["distilled_guidance_layer.in_proj.weight"]
            actual_ahd = in_proj.shape[0]
            actual_anc = in_proj.shape[1]
            for key, val in (("approximator_hidden_dim", actual_ahd),
                              ("approximator_num_channels", actual_anc),
                              ("in_channels", actual_anc)):
                if key in cfg and cfg[key] != val:
                    cfg[key] = val
                    patched = True

        # Detect fused SwiGLU in approximator layers.
        # Standard PixArtAlphaTextProjection: linear_1 is [hidden, hidden].
        # Fused SwiGLU variant: linear_1 is [hidden, 2*hidden] (gate+up combined).
        # Store as approximator_fused_swiglu so the loader can patch the class.
        layer0_linear1 = "distilled_guidance_layer.layers.0.linear_1.weight"
        if layer0_linear1 in state_dict and "distilled_guidance_layer.in_proj.weight" in state_dict:
            l1 = state_dict[layer0_linear1]
            ahd = state_dict["distilled_guidance_layer.in_proj.weight"].shape[0]
            is_fused = (l1.shape[1] == ahd * 2)
            if cfg.get("approximator_fused_swiglu") != is_fused:
                cfg["approximator_fused_swiglu"] = is_fused
                patched = True

        # approximator_layers: count unique layer indices under distilled_guidance_layer.layers
        layer_indices = {
            int(k.split(".")[2])
            for k in state_dict
            if k.startswith("distilled_guidance_layer.layers.")
            and len(k.split(".")) > 3
        }
        if layer_indices:
            actual_layers = max(layer_indices) + 1
            if "approximator_layers" in cfg and cfg["approximator_layers"] != actual_layers:
                cfg["approximator_layers"] = actual_layers
                patched = True

        if patched:
            with open(config_path_out, "w") as f:
                json.dump(cfg, f, indent=2)
            emit("saving", 0.92, "Config patched: shape fields corrected from actual weights")
    except Exception as e:
        emit("saving", 0.92, f"Warning: config patch step failed (non-fatal): {e}")

    del state_dict, shards, transformer
    _free_memory()
    emit("done", 1.0, f"Conversion complete in {time.time()-t0:.1f}s")


# ── SDXL — full pipeline ──────────────────────────────────────────────────────

def convert_sdxl(model_path: str, out_dir: str, dtype_str: str):
    from diffusers import StableDiffusionXLPipeline
    dtype = dtype_torch(dtype_str)
    emit("loading", 0.0, f"Loading {os.path.basename(model_path)} via from_single_file ...")
    t0 = time.time()
    pipe = StableDiffusionXLPipeline.from_single_file(
        model_path, torch_dtype=dtype, use_safetensors=True,
    )
    emit("saving", 0.5, f"Loaded in {time.time()-t0:.1f}s — saving diffusers directory ...")
    os.makedirs(out_dir, exist_ok=True)
    pipe.save_pretrained(out_dir, safe_serialization=True)
    del pipe
    _free_memory()
    emit("done", 1.0, f"Conversion complete in {time.time()-t0:.1f}s")


# ── FLUX / Chroma / Kontext ───────────────────────────────────────────────────

def convert_flux(model_path: str, out_dir: str, dtype_str: str, config_path):
    from diffusers import FluxTransformer2DModel, GGUFQuantizationConfig
    dtype = dtype_torch(dtype_str)
    config_repo = config_path or "ostris/Flex.1-alpha"
    emit("loading", 0.0, f"Loading {os.path.basename(model_path)} (FLUX transformer, GGUF dequant) ...")
    t0 = time.time()
    transformer = FluxTransformer2DModel.from_single_file(
        model_path,
        quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
        config=config_repo,
        subfolder="transformer",
        torch_dtype=dtype,
    )
    _materialize_and_save_transformer(transformer, out_dir, dtype, t0, config_repo=config_repo)


def convert_chroma(model_path: str, out_dir: str, dtype_str: str, config_path):
    from diffusers import ChromaTransformer2DModel, GGUFQuantizationConfig
    dtype = dtype_torch(dtype_str)
    config_repo = config_path or "lodestones/Chroma1-HD"
    emit("loading", 0.0, f"Loading {os.path.basename(model_path)} (Chroma transformer, GGUF dequant) ...")
    t0 = time.time()
    transformer = ChromaTransformer2DModel.from_single_file(
        model_path,
        quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
        config=config_repo,
        subfolder="transformer",
        torch_dtype=dtype,
    )
    _materialize_and_save_transformer(transformer, out_dir, dtype, t0, config_repo=config_repo)


def convert_kontext(model_path: str, out_dir: str, dtype_str: str, config_path):
    # Kontext uses FluxTransformer2DModel — same class, different weights
    from diffusers import FluxTransformer2DModel, GGUFQuantizationConfig
    dtype = dtype_torch(dtype_str)
    config_repo = config_path or "ostris/Flex.1-alpha"
    emit("loading", 0.0, f"Loading {os.path.basename(model_path)} (Kontext transformer, GGUF dequant) ...")
    t0 = time.time()
    transformer = FluxTransformer2DModel.from_single_file(
        model_path,
        quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
        config=config_repo,
        subfolder="transformer",
        torch_dtype=dtype,
    )
    _materialize_and_save_transformer(transformer, out_dir, dtype, t0, config_repo=config_repo)


# ── Wan ───────────────────────────────────────────────────────────────────────

WAN_CONFIG_1_3B = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"
WAN_CONFIG_14B  = "Wan-AI/Wan2.1-T2V-14B-Diffusers"

def convert_wan(model_path: str, out_dir: str, dtype_str: str, config_path):
    from diffusers import WanTransformer3DModel, GGUFQuantizationConfig
    dtype = dtype_torch(dtype_str)
    # Infer 1.3B vs 14B from file size if no config provided
    if config_path:
        config_repo = config_path
    elif os.path.getsize(model_path) < 3_000_000_000:
        config_repo = WAN_CONFIG_1_3B
    else:
        config_repo = WAN_CONFIG_14B
    size_gb = os.path.getsize(model_path) / 1e9
    emit("loading", 0.0, f"Loading {os.path.basename(model_path)} ({size_gb:.1f} GB, Wan transformer, GGUF dequant) ...")
    emit("loading", 0.02, f"Using config: {config_repo}")
    t0 = time.time()
    transformer = WanTransformer3DModel.from_single_file(
        model_path,
        quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
        config=config_repo,
        subfolder="transformer",
        torch_dtype=dtype,
    )
    _materialize_and_save_transformer(transformer, out_dir, dtype, t0, config_repo=config_repo)


# ── Qwen-Image ────────────────────────────────────────────────────────────────

def convert_qwen_image(model_path: str, out_dir: str, dtype_str: str, config_path):
    from diffusers import QwenImageTransformer2DModel, GGUFQuantizationConfig
    dtype = dtype_torch(dtype_str)
    config_repo = config_path or "Qwen/Qwen-Image"
    emit("loading", 0.0, f"Loading {os.path.basename(model_path)} (Qwen-Image transformer, GGUF dequant) ...")
    t0 = time.time()
    transformer = QwenImageTransformer2DModel.from_single_file(
        model_path,
        quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
        config=config_repo,
        subfolder="transformer",
        torch_dtype=dtype,
    )
    _materialize_and_save_transformer(transformer, out_dir, dtype, t0, config_repo=config_repo)


# ── Z-Image ───────────────────────────────────────────────────────────────────

def convert_zimage(model_path: str, out_dir: str, dtype_str: str, config_path):
    """
    Z-Image has a GGUF packaging bug: cap_pad_token is stored as shape (dim,)
    but the model expects (1, dim). We apply the unsqueeze fix before saving
    so the saved BF16 weights have the correct shape and the fast-path loader
    needs no special handling.
    """
    try:
        from diffusers.models.transformers import ZImageTransformer2DModel
    except ImportError:
        raise ImportError("ZImageTransformer2DModel not found — requires diffusers >= 0.36.0")
    from diffusers import GGUFQuantizationConfig
    import torch
    dtype = dtype_torch(dtype_str)

    emit("loading", 0.0, f"Loading {os.path.basename(model_path)} (Z-Image transformer, GGUF dequant) ...")
    t0 = time.time()

    transformer = ZImageTransformer2DModel.from_single_file(
        model_path,
        quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
        torch_dtype=dtype,
        low_cpu_mem_usage=False,
        ignore_mismatched_sizes=True,
    )

    # Fix cap_pad_token shape so the saved weights are correct
    if hasattr(transformer, "cap_pad_token") and transformer.cap_pad_token.ndim == 1:
        with torch.no_grad():
            transformer.cap_pad_token.data = transformer.cap_pad_token.data.unsqueeze(0)

    _materialize_and_save_transformer(transformer, out_dir, dtype, t0)


# ── Main ──────────────────────────────────────────────────────────────────────

TRANSFORMER_ONLY = {"flux", "chroma", "kontext", "wan", "qwen-image", "z-image"}

def main():
    args = parse_args()
    out_dir          = os.path.join(args.output_dir, args.model_id)
    transformer_only = args.model_type in TRANSFORMER_ONLY

    if _already_converted(out_dir, transformer_only):
        emit("done", 1.0, f"Already converted — {out_dir}")
        return

    if not os.path.exists(args.model_path):
        emit_error(f"Source model not found: {args.model_path}")
        sys.exit(1)

    try:
        dispatch = {
            "sdxl":        lambda: convert_sdxl(args.model_path, out_dir, args.dtype),
            "flux":        lambda: convert_flux(args.model_path, out_dir, args.dtype, args.config_path),
            "chroma":      lambda: convert_chroma(args.model_path, out_dir, args.dtype, args.config_path),
            "kontext":     lambda: convert_kontext(args.model_path, out_dir, args.dtype, args.config_path),
            "wan":         lambda: convert_wan(args.model_path, out_dir, args.dtype, args.config_path),
            "qwen-image":  lambda: convert_qwen_image(args.model_path, out_dir, args.dtype, args.config_path),
            "z-image":     lambda: convert_zimage(args.model_path, out_dir, args.dtype, args.config_path),
        }
        dispatch[args.model_type]()

    except Exception as e:
        import traceback
        emit_error(f"{type(e).__name__}: {e}\n{traceback.format_exc()}")
        sys.exit(1)


if __name__ == "__main__":
    main()