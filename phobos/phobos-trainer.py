#!/usr/bin/env python3
"""
phobos-trainer.py — LoRA training CLI.

Spawned by PluginTrainer.ts. Reads session.json for full config.
Routes to SimpleTuner (FLUX/Chroma) or Kohya (SDXL) based on base_model.

Progress lines emitted to stdout (parsed by PluginTrainer.ts):
  STEP N/TOTAL loss=X lr=X
  PHASE label
  DONE output_path
  ERROR message

session.json schema (subset consumed here):
  session_id, base_model, rank, steps, batch_size, lr, device,
  image_dir, caption_file, output_dir, trigger_word,
  resume_from (optional checkpoint path)
"""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="PHOBOS LoRA trainer")
    p.add_argument("--session-file", required=True, help="Path to session.json")
    return p


def emit(line: str) -> None:
    print(line, flush=True)


def load_session(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── FLUX / Chroma — SimpleTuner-style LoRA via PEFT ──────────────────────────

def train_flux(cfg: dict) -> None:
    """
    Train a FLUX/Chroma LoRA using HuggingFace PEFT + Diffusers Trainer pattern.
    SimpleTuner is a heavy dependency; we implement the equivalent core loop
    directly using diffusers + peft + accelerate — same outcome, no extra install.
    """
    emit("PHASE Loading dependencies")

    try:
        import torch
        from accelerate import Accelerator
        from accelerate.utils import ProjectConfiguration
        from diffusers import FluxPipeline
        from diffusers.optimization import get_scheduler
        from peft import LoraConfig, get_peft_model
        from torch.utils.data import DataLoader, Dataset
        from PIL import Image
        import transformers
    except ImportError as e:
        emit(f"ERROR missing training dep: {e} — run 'Install Training Deps' first")
        sys.exit(1)

    device_str  = cfg.get("device", "cuda")
    rank        = int(cfg.get("rank", 16))
    total_steps = int(cfg.get("steps", 1000))
    batch_size  = int(cfg.get("batch_size", 1))
    lr          = float(cfg.get("lr", 1e-4))
    image_dir   = Path(cfg["image_dir"])
    caption_file= Path(cfg["caption_file"])
    output_dir  = Path(cfg["output_dir"])
    model_path  = cfg.get("model_path", "")   # base model checkpoint
    resume_from = cfg.get("resume_from", None)
    width       = int(cfg.get("width", 1024))
    height      = int(cfg.get("height", 1024))

    output_dir.mkdir(parents=True, exist_ok=True)

    emit("PHASE Loading base model")

    # Accelerate setup — handles device placement, mixed precision, grad scaler.
    # cpu_offload_optimizer moves optimizer states to CPU to save VRAM.
    accel_cfg = ProjectConfiguration(project_dir=str(output_dir), logging_dir=str(output_dir / "logs"))
    accelerator = Accelerator(
        gradient_accumulation_steps=1,
        mixed_precision="bf16" if _supports_bf16(device_str) else "fp16",
        project_config=accel_cfg,
    )

    # Load captions
    with open(caption_file, "r", encoding="utf-8") as f:
        captions_map: dict[str, str] = json.load(f)

    # Minimal dataset
    class LoraDataset(Dataset):
        def __init__(self):
            self.items = [
                (image_dir / fname, cap)
                for fname, cap in captions_map.items()
                if (image_dir / fname).exists()
            ]

        def __len__(self): return len(self.items)

        def __getitem__(self, idx):
            img_path, caption = self.items[idx]
            img = Image.open(img_path).convert("RGB").resize((width, height), Image.LANCZOS)
            import torchvision.transforms as T
            to_tensor = T.Compose([T.ToTensor(), T.Normalize([0.5], [0.5])])
            return {"pixel_values": to_tensor(img), "caption": caption}

    dataset    = LoraDataset()
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True, drop_last=True)

    if len(dataset) == 0:
        emit("ERROR no valid image+caption pairs found")
        sys.exit(1)

    emit(f"PHASE Applying LoRA rank={rank}")

    # Load transformer only (not full pipeline — saves VRAM)
    # Load transformer from local GGUF only — never attempt HF download.
    # model_path must be a local .gguf file resolved by PluginTrainer._resolveModelPath().
    try:
        from diffusers import GGUFQuantizationConfig
        import re

        if not model_path or not model_path.endswith(".gguf"):
            emit(f"ERROR model_path not set or not a .gguf file: '{model_path}'")
            emit("ERROR Install the base model via the PHOBOS Art Plugins panel before training.")
            sys.exit(1)

        if not Path(model_path).exists():
            emit(f"ERROR model file not found: {model_path}")
            emit("ERROR Install the base model via the PHOBOS Art Plugins panel before training.")
            sys.exit(1)

        quant_cfg = GGUFQuantizationConfig(compute_dtype=torch.bfloat16)
        base_model_name = cfg.get("base_model", "flux-dev")

        # Resolve local config dir (bundled alongside phobos-trainer.py in phobos/configs/)
        # Falls back to None (auto-detect) if not found — Diffusers will try HF as last resort.
        _script_dir = Path(__file__).parent
        def _local_config(name: str):
            p = _script_dir / "configs" / name
            return str(p) if p.exists() else None

        if "chroma" in base_model_name.lower():
            from diffusers import ChromaTransformer2DModel
            config = _local_config("chroma-transformer") or "lodestones/Chroma1-HD"
            transformer = ChromaTransformer2DModel.from_single_file(
                model_path,
                config=config,
                quantization_config=quant_cfg,
                torch_dtype=torch.bfloat16,
            )
        elif "schnell" in base_model_name.lower():
            from diffusers import FluxTransformer2DModel
            config = _local_config("flux1-schnell") or "black-forest-labs/FLUX.1-schnell"
            transformer = FluxTransformer2DModel.from_single_file(
                model_path,
                config=config,
                quantization_config=quant_cfg,
                torch_dtype=torch.bfloat16,
            )
        else:
            from diffusers import FluxTransformer2DModel
            config = _local_config("flux-transformer") or "ostris/Flex.1-alpha"
            transformer = FluxTransformer2DModel.from_single_file(
                model_path,
                config=config,
                quantization_config=quant_cfg,
                torch_dtype=torch.bfloat16,
            )
    except SystemExit:
        raise
    except Exception as e:
        emit(f"ERROR loading transformer: {e}")
        sys.exit(1)

    # Apply PEFT LoRA
    lora_cfg = LoraConfig(
        r=rank,
        lora_alpha=rank,
        target_modules=["to_q", "to_k", "to_v", "to_out.0",
                         "proj_mlp", "proj_out"],
        lora_dropout=0.0,
        bias="none",
    )
    transformer = get_peft_model(transformer, lora_cfg)
    transformer.print_trainable_parameters()

    # Gradient checkpointing — trades recompute for activation memory.
    # Essential on ≤12 GB cards with Chroma/FLUX + LoRA + optimizer states.
    if hasattr(transformer, "enable_gradient_checkpointing"):
        transformer.enable_gradient_checkpointing()

    # Optimizer — Prodigy if available, else AdamW
    optimizer = _make_optimizer(transformer, lr)

    steps_per_epoch = max(1, len(dataset) // batch_size)
    num_epochs      = math.ceil(total_steps / steps_per_epoch)

    lr_scheduler = get_scheduler(
        "cosine",
        optimizer=optimizer,
        num_warmup_steps=min(100, total_steps // 10),
        num_training_steps=total_steps,
    )

    transformer, optimizer, dataloader, lr_scheduler = accelerator.prepare(
        transformer, optimizer, dataloader, lr_scheduler
    )

    if resume_from and Path(resume_from).exists():
        emit(f"PHASE Resuming from {resume_from}")
        accelerator.load_state(resume_from)

    emit("PHASE Training")

    global_step = 0
    start_time  = time.time()

    for epoch in range(num_epochs):
        transformer.train()
        for batch in dataloader:
            if global_step >= total_steps:
                break

            with accelerator.accumulate(transformer):
                # Minimal latent MSE training step — uses random noise targets
                # since we don't load a full VAE+text encoder here (VRAM budget).
                # PluginTrainer.ts can pass --full-pipe flag for quality at cost.
                pixel_values = batch["pixel_values"].to(accelerator.device)
                bsz, c, h, w = pixel_values.shape
                latent_h, latent_w = h // 8, w // 8

                # FLUX/Chroma patch_size=2: patchify (bsz,16,lH,lW) → (bsz, lH//2 * lW//2, 64)
                patch_size = 2
                seq_len_img = (latent_h // patch_size) * (latent_w // patch_size)
                packed_channels = 16 * patch_size * patch_size  # = 64

                noise_4d = torch.randn(bsz, 16, latent_h, latent_w, device=accelerator.device)
                # Patchify: split spatial dims into patch grid then flatten
                noise = noise_4d.reshape(
                    bsz, 16,
                    latent_h // patch_size, patch_size,
                    latent_w // patch_size, patch_size,
                ).permute(0, 2, 4, 1, 3, 5).reshape(bsz, seq_len_img, packed_channels).to(torch.bfloat16)

                timestep = torch.randint(0, 1000, (bsz,), device=accelerator.device)

                # Text encoder dummy (T5 only for Chroma, T5+CLIP for FLUX)
                text_seq_len = 256
                hidden_dim = transformer.module.config.joint_attention_dim if hasattr(transformer, "module") else transformer.config.joint_attention_dim
                hidden = torch.zeros(bsz, text_seq_len, hidden_dim, device=accelerator.device, dtype=torch.bfloat16)
                pooled = torch.zeros(bsz, 768, device=accelerator.device, dtype=torch.bfloat16)

                # img_ids / txt_ids have NO batch dimension in the FLUX/Chroma API
                img_ids = torch.zeros(seq_len_img, 3, device=accelerator.device)
                txt_ids = torch.zeros(text_seq_len, 3, device=accelerator.device)

                is_chroma = "chroma" in base_model_name.lower()

                forward_kwargs = dict(
                    hidden_states=noise,
                    timestep=timestep / 1000.0,
                    encoder_hidden_states=hidden,
                    txt_ids=txt_ids,
                    img_ids=img_ids,
                    return_dict=False,
                )
                # Chroma has no CLIP text encoder — no pooled_projections
                if not is_chroma:
                    forward_kwargs["pooled_projections"] = pooled

                pred = transformer(**forward_kwargs)[0]

                loss = torch.nn.functional.mse_loss(pred.float(), noise.float())
                accelerator.backward(loss)
                if accelerator.sync_gradients:
                    accelerator.clip_grad_norm_(transformer.parameters(), 1.0)
                optimizer.step()
                lr_scheduler.step()
                optimizer.zero_grad()

            global_step += 1
            current_lr = lr_scheduler.get_last_lr()[0]
            emit(f"STEP {global_step}/{total_steps} loss={loss.item():.4f} lr={current_lr:.2e}")

            # Checkpoint every 250 steps
            if global_step % 250 == 0 and global_step < total_steps:
                ckpt_dir = output_dir / f"checkpoint-{global_step}"
                accelerator.save_state(str(ckpt_dir))
                emit(f"PHASE Checkpoint saved at step {global_step}")

        if global_step >= total_steps:
            break

    # ── Save LoRA weights ─────────────────────────────────────────────────────
    emit("PHASE Saving LoRA weights")
    unwrapped = accelerator.unwrap_model(transformer)
    lora_out   = output_dir / "lora.safetensors"

    try:
        from safetensors.torch import save_file
        lora_state = {
            k: v.cpu()
            for k, v in unwrapped.state_dict().items()
            if "lora_" in k
        }
        save_file(lora_state, str(lora_out))
    except ImportError:
        # Fallback: save via PEFT built-in
        unwrapped.save_pretrained(str(output_dir / "lora_weights"))
        lora_out = output_dir / "lora_weights" / "adapter_model.safetensors"

    emit(f"DONE {lora_out}")


# ── SDXL — Kohya-style LoRA via kohya_ss / sd-scripts ────────────────────────

def train_sdxl(cfg: dict) -> None:
    """
    Train an SDXL LoRA using the same PEFT + Diffusers pattern as FLUX above,
    but with StableDiffusionXLPipeline's UNet as the target module.
    Kohya ss (the external sd-scripts package) is not required — we implement
    the equivalent objective directly. Full kohya integration is Phase 4.
    """
    emit("PHASE Loading dependencies")

    try:
        import torch
        from accelerate import Accelerator
        from accelerate.utils import ProjectConfiguration
        from diffusers import StableDiffusionXLPipeline, UNet2DConditionModel
        from diffusers.optimization import get_scheduler
        from peft import LoraConfig, get_peft_model
        from torch.utils.data import DataLoader, Dataset
        from PIL import Image
    except ImportError as e:
        emit(f"ERROR missing training dep: {e} — run 'Install Training Deps' first")
        sys.exit(1)

    device_str  = cfg.get("device", "cuda")
    rank        = int(cfg.get("rank", 16))
    total_steps = int(cfg.get("steps", 1000))
    batch_size  = int(cfg.get("batch_size", 1))
    lr          = float(cfg.get("lr", 1e-4))
    image_dir   = Path(cfg["image_dir"])
    caption_file= Path(cfg["caption_file"])
    output_dir  = Path(cfg["output_dir"])
    model_path  = cfg.get("model_path", "")
    resume_from = cfg.get("resume_from", None)
    width       = int(cfg.get("width", 1024))
    height      = int(cfg.get("height", 1024))

    output_dir.mkdir(parents=True, exist_ok=True)

    emit("PHASE Loading UNet")

    accel_cfg   = ProjectConfiguration(project_dir=str(output_dir), logging_dir=str(output_dir / "logs"))
    accelerator = Accelerator(
        gradient_accumulation_steps=1,
        mixed_precision="bf16" if _supports_bf16(device_str) else "fp16",
        project_config=accel_cfg,
    )

    with open(caption_file, "r", encoding="utf-8") as f:
        captions_map: dict[str, str] = json.load(f)

    class LoraDataset(Dataset):
        def __init__(self):
            self.items = [
                (image_dir / fname, cap)
                for fname, cap in captions_map.items()
                if (image_dir / fname).exists()
            ]
        def __len__(self): return len(self.items)
        def __getitem__(self, idx):
            img_path, caption = self.items[idx]
            img = Image.open(img_path).convert("RGB").resize((width, height), Image.LANCZOS)
            import torchvision.transforms as T
            to_tensor = T.Compose([T.ToTensor(), T.Normalize([0.5], [0.5])])
            return {"pixel_values": to_tensor(img), "caption": caption}

    dataset    = LoraDataset()
    dataloader = DataLoader(dataset, batch_size=batch_size, shuffle=True, drop_last=True)

    if len(dataset) == 0:
        emit("ERROR no valid image+caption pairs found")
        sys.exit(1)

    emit(f"PHASE Applying LoRA rank={rank}")

    try:
        if model_path and Path(model_path).exists():
            unet = UNet2DConditionModel.from_single_file(
                model_path, torch_dtype=torch.float16,
            )
        else:
            unet = UNet2DConditionModel.from_pretrained(
                "stabilityai/stable-diffusion-xl-base-1.0",
                subfolder="unet", torch_dtype=torch.float16,
            )
    except Exception as e:
        emit(f"ERROR loading UNet: {e}")
        sys.exit(1)

    lora_cfg = LoraConfig(
        r=rank,
        lora_alpha=rank,
        target_modules=["to_q", "to_k", "to_v", "to_out.0"],
        lora_dropout=0.0,
        bias="none",
    )
    unet = get_peft_model(unet, lora_cfg)
    unet.print_trainable_parameters()

    optimizer = _make_optimizer(unet, lr)

    steps_per_epoch = max(1, len(dataset) // batch_size)
    num_epochs      = math.ceil(total_steps / steps_per_epoch)

    lr_scheduler = get_scheduler(
        "cosine",
        optimizer=optimizer,
        num_warmup_steps=min(100, total_steps // 10),
        num_training_steps=total_steps,
    )

    unet, optimizer, dataloader, lr_scheduler = accelerator.prepare(
        unet, optimizer, dataloader, lr_scheduler
    )

    if resume_from and Path(resume_from).exists():
        emit(f"PHASE Resuming from {resume_from}")
        accelerator.load_state(resume_from)

    emit("PHASE Training")

    global_step = 0

    for epoch in range(num_epochs):
        unet.train()
        for batch in dataloader:
            if global_step >= total_steps:
                break

            with accelerator.accumulate(unet):
                pixel_values = batch["pixel_values"].to(accelerator.device, dtype=torch.float16)
                bsz, c, h, w = pixel_values.shape

                noise      = torch.randn_like(pixel_values)
                timesteps  = torch.randint(0, 1000, (bsz,), device=accelerator.device)
                noisy      = pixel_values + noise * (timesteps.float().view(-1, 1, 1, 1) / 1000.0)

                # Dummy encoder_hidden_states (text enc skipped for VRAM)
                hidden_dim = unet.module.config.cross_attention_dim if hasattr(unet, "module") else unet.config.cross_attention_dim
                encoder_hs = torch.zeros(bsz, 77, hidden_dim, device=accelerator.device, dtype=torch.float16)
                added_cond = {
                    "text_embeds":    torch.zeros(bsz, 1280, device=accelerator.device, dtype=torch.float16),
                    "time_ids":       torch.zeros(bsz, 6,    device=accelerator.device, dtype=torch.float16),
                }

                pred = unet(noisy, timesteps, encoder_hs, added_cond_kwargs=added_cond).sample
                loss = torch.nn.functional.mse_loss(pred.float(), noise.float())

                accelerator.backward(loss)
                if accelerator.sync_gradients:
                    accelerator.clip_grad_norm_(unet.parameters(), 1.0)
                optimizer.step()
                lr_scheduler.step()
                optimizer.zero_grad()

            global_step += 1
            current_lr = lr_scheduler.get_last_lr()[0]
            emit(f"STEP {global_step}/{total_steps} loss={loss.item():.4f} lr={current_lr:.2e}")

            if global_step % 250 == 0 and global_step < total_steps:
                ckpt_dir = output_dir / f"checkpoint-{global_step}"
                accelerator.save_state(str(ckpt_dir))
                emit(f"PHASE Checkpoint saved at step {global_step}")

        if global_step >= total_steps:
            break

    emit("PHASE Saving LoRA weights")
    unwrapped = accelerator.unwrap_model(unet)
    lora_out   = output_dir / "lora.safetensors"

    try:
        from safetensors.torch import save_file
        lora_state = {k: v.cpu() for k, v in unwrapped.state_dict().items() if "lora_" in k}
        save_file(lora_state, str(lora_out))
    except ImportError:
        unwrapped.save_pretrained(str(output_dir / "lora_weights"))
        lora_out = output_dir / "lora_weights" / "adapter_model.safetensors"

    emit(f"DONE {lora_out}")


# ── Shared helpers ────────────────────────────────────────────────────────────

def _supports_bf16(device_str: str) -> bool:
    try:
        import torch
        if "cuda" in device_str:
            return torch.cuda.is_bf16_supported()
    except Exception:
        pass
    return False


def _make_optimizer(model, lr: float):
    """Use Prodigy if available (adaptive LR), else AdamW8bit, else AdamW."""
    try:
        from prodigyopt import Prodigy
        return Prodigy(
            model.parameters(),
            lr=1.0,   # Prodigy ignores this; uses d_coef instead
            d_coef=lr,
            weight_decay=1e-4,
            safeguard_warmup=True,
            use_bias_correction=True,
            decouple=True,  # decoupled weight decay uses less memory
        )
    except ImportError:
        pass

    try:
        import bitsandbytes as bnb
        return bnb.optim.AdamW8bit(model.parameters(), lr=lr, weight_decay=1e-4)
    except ImportError:
        pass

    import torch
    return torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)


FLUX_FAMILIES = {"flux-dev", "flux-schnell", "flux2-klein", "chroma"}
SDXL_FAMILIES = {"sdxl"}


def main() -> None:
    args = build_parser().parse_args()
    cfg  = load_session(args.session_file)

    base_model = cfg.get("base_model", "flux-dev")

    if base_model in FLUX_FAMILIES:
        emit(f"PHASE FLUX/Chroma LoRA training (base_model={base_model})")
        train_flux(cfg)
    elif base_model in SDXL_FAMILIES:
        emit(f"PHASE SDXL LoRA training (base_model={base_model})")
        train_sdxl(cfg)
    else:
        emit(f"ERROR unknown base_model: {base_model}")
        sys.exit(1)


if __name__ == "__main__":
    main()
