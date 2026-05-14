#!/usr/bin/env python3
"""
phobos-lm-trainer.py — LLM LoRA training script for PHOBOS Cartridges.

Spawned by CartridgeTrainer.ts. Reads session.json for full config.
Downloads base model via unsloth (HF safetensors, 4-bit quantized).
HF_HOME is set by the caller to ~/.phobos/cartridge-training-cache so
the download lands in a user-visible, deletable location.

Progress lines emitted to stdout (parsed by CartridgeTrainer.ts):
  STEP N/TOTAL loss=X
  PHASE label
  DONE <safetensors_path> <gguf_path>
  ERROR message

session.json fields consumed here:
  session_id, training_hf_id, base_model_id, rank, steps, lr,
  device, mixed_precision, data_mode,
  dataset_dir, output_dir, resume_from
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


# ── Entry point ───────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="PHOBOS LLM LoRA trainer")
    p.add_argument("--session-file", required=True, help="Path to session.json")
    return p


def emit(line: str) -> None:
    print(line, flush=True)


def load_session(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ── Document preprocessing ────────────────────────────────────────────────────

def preprocess_documents(dataset_dir: Path, output_jsonl: Path) -> int:
    """
    Convert source documents to (instruction, response) JSONL pairs.
    Chunks each document into segments and wraps as self-supervised pairs.
    Returns the number of pairs written.
    """
    emit("PHASE Preprocessing documents")

    DOC_EXTS = {".md", ".txt", ".py", ".ts", ".js", ".json", ".html"}
    PDF_EXT  = ".pdf"
    CHUNK_TOKENS = 512   # approximate — split on word count
    OVERLAP_WORDS = 32

    pairs: list[dict] = []

    for fpath in sorted(dataset_dir.iterdir()):
        ext = fpath.suffix.lower()
        if ext not in DOC_EXTS and ext != PDF_EXT:
            continue

        try:
            if ext == PDF_EXT:
                text = _extract_pdf(fpath)
            elif ext == ".json":
                text = _extract_json_text(fpath)
            else:
                text = fpath.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            emit(f"PHASE Skipping {fpath.name}: {e}")
            continue

        text = text.strip()
        if not text:
            continue

        chunks = _chunk_text(text, CHUNK_TOKENS, OVERLAP_WORDS)
        for i, chunk in enumerate(chunks):
            if i == 0:
                pairs.append({
                    "messages": [
                        {"role": "user",      "content": f"Summarize or explain: {chunk[:100]}..."},
                        {"role": "assistant", "content": chunk},
                    ]
                })
            else:
                # Continuation pair — teaches the model the document's content
                pairs.append({
                    "messages": [
                        {"role": "user",      "content": "Continue."},
                        {"role": "assistant", "content": chunk},
                    ]
                })

    if not pairs:
        emit("ERROR No text content found in document dataset")
        sys.exit(1)

    with open(output_jsonl, "w", encoding="utf-8") as f:
        for pair in pairs:
            f.write(json.dumps(pair) + "\n")

    emit(f"PHASE Preprocessed {len(pairs)} training pairs from {len(list(dataset_dir.iterdir()))} files")
    return len(pairs)


def preprocess_conversations(dataset_dir: Path, output_jsonl: Path) -> int:
    """
    Reads .jsonl files of {"user": "...", "assistant": "..."} pairs.
    Converts to messages format and writes to output_jsonl.
    Returns the number of pairs.
    """
    emit("PHASE Preprocessing conversations")
    count = 0
    with open(output_jsonl, "w", encoding="utf-8") as out:
        for fpath in sorted(dataset_dir.iterdir()):
            if fpath.suffix.lower() != ".jsonl":
                continue
            with open(fpath, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    # Accept {"user": ..., "assistant": ...} or {"messages": [...]}
                    if "messages" in obj:
                        out.write(json.dumps(obj) + "\n")
                        count += 1
                    elif "user" in obj and "assistant" in obj:
                        out.write(json.dumps({
                            "messages": [
                                {"role": "user",      "content": str(obj["user"])},
                                {"role": "assistant", "content": str(obj["assistant"])},
                            ]
                        }) + "\n")
                        count += 1

    emit(f"PHASE Loaded {count} conversation turns")
    return count


def _chunk_text(text: str, chunk_words: int, overlap_words: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks = []
    i = 0
    while i < len(words):
        end = min(i + chunk_words, len(words))
        chunks.append(" ".join(words[i:end]))
        i += chunk_words - overlap_words
        if i >= len(words):
            break
    return [c for c in chunks if len(c.split()) >= 20]  # drop tiny tail chunks


def _extract_pdf(fpath: Path) -> str:
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(fpath))
        return "\n\n".join(p.extract_text() or "" for p in reader.pages)
    except ImportError:
        emit("PHASE pypdf not installed — skipping PDF files")
        return ""


def _extract_json_text(fpath: Path) -> str:
    """Extract string values from a JSON file recursively."""
    def _collect(obj) -> list[str]:
        if isinstance(obj, str):
            return [obj] if len(obj) > 20 else []
        if isinstance(obj, dict):
            return [s for v in obj.values() for s in _collect(v)]
        if isinstance(obj, list):
            return [s for item in obj for s in _collect(item)]
        return []

    with open(fpath, "r", encoding="utf-8") as f:
        data = json.load(f)
    return "\n\n".join(_collect(data))


# ── Training ──────────────────────────────────────────────────────────────────

def train(cfg: dict) -> None:
    emit("PHASE Loading training dependencies")

    try:
        from unsloth import FastLanguageModel
        from trl import SFTTrainer, SFTConfig
        from datasets import Dataset
        import torch
    except ImportError as e:
        emit(f"ERROR Missing training dep: {e} — run 'Install Training Deps' first")
        sys.exit(1)

    training_hf_id  = cfg["training_hf_id"]
    rank            = int(cfg.get("rank", 16))
    steps           = int(cfg.get("steps", 0))
    lr              = float(cfg.get("lr", 2e-4))
    device          = cfg.get("device", "cuda")
    vendor          = cfg.get("vendor", "cuda")
    mixed_precision = cfg.get("mixed_precision", "bf16")
    data_mode       = cfg.get("data_mode", "document")
    dataset_dir     = Path(cfg["dataset_dir"])
    output_dir      = Path(cfg["output_dir"])
    resume_from     = cfg.get("resume_from") or None

    # ── Optimizer — adamw_8bit is bitsandbytes CUDA-only ──────────────────────
    # ROCm Linux: adamw_torch_fused (native HIP, fast).
    # ROCm Windows: adamw_torch (fused not available in AMD Windows torch build).
    # XPU / MPS / CPU: adamw_torch (bitsandbytes has no support for these backends).
    if vendor == "cuda":
        optim = "adamw_8bit"
    elif vendor == "rocm" and sys.platform != "win32":
        optim = "adamw_torch_fused"
    else:
        optim = "adamw_torch"

    # ── load_in_4bit — bitsandbytes 4-bit quantization is CUDA-only ──────────
    # XPU (Intel Arc): load full bf16 weights. A770/A750 have 16 GB — fits fine.
    # ROCm (AMD): bitsandbytes 4-bit is unreliable on Windows ROCm. The 890M has
    #   48 GB unified memory — full bf16 weights for 1.5B fit easily (~3 GB).
    # CUDA / MPS / CPU: 4-bit saves VRAM and is supported by unsloth/bnb.
    load_in_4bit = vendor not in ("xpu", "rocm")

    # ── XPU fp64 workaround ───────────────────────────────────────────────────
    # Intel Arc does not support fp64 in hardware. Unsloth's RoPE path calls
    # torch.arange(..., dtype=float64). Patch it to silently downcast to float32,
    # exactly as phobos-diffusers.py does for image generation on Arc.
    if device.startswith("xpu"):
        import torch as _torch_pre
        _orig_arange = _torch_pre.arange
        def _xpu_safe_arange(*a, **kw):
            if kw.get("dtype") == _torch_pre.float64:
                kw["dtype"] = _torch_pre.float32
            return _orig_arange(*a, **kw)
        _torch_pre.arange = _xpu_safe_arange
        emit("PHASE XPU: fp64->fp32 arange patch applied (Arc fp64 workaround)")

    output_dir.mkdir(parents=True, exist_ok=True)
    preprocessed_jsonl = output_dir / "preprocessed.jsonl"

    # ── Preprocess dataset ────────────────────────────────────────────────────
    if data_mode == "document":
        pair_count = preprocess_documents(dataset_dir, preprocessed_jsonl)
    elif data_mode == "conversation":
        pair_count = preprocess_conversations(dataset_dir, preprocessed_jsonl)
    else:
        # mixed: both document and conversation files in dataset_dir
        doc_jsonl  = output_dir / "preprocessed_docs.jsonl"
        conv_jsonl = output_dir / "preprocessed_conv.jsonl"
        doc_count  = preprocess_documents(dataset_dir, doc_jsonl)
        conv_count = preprocess_conversations(dataset_dir, conv_jsonl)
        # Merge
        with open(preprocessed_jsonl, "w", encoding="utf-8") as out:
            for src in [doc_jsonl, conv_jsonl]:
                if src.exists():
                    out.write(src.read_text(encoding="utf-8"))
        pair_count = doc_count + conv_count

    if pair_count == 0:
        emit("ERROR Dataset produced zero training pairs")
        sys.exit(1)

    # ── Auto-compute steps if not provided ───────────────────────────────────
    if steps <= 0:
        repeats          = max(1, math.floor(500 / pair_count))
        target_ep_steps  = 80 if rank <= 16 else 120
        steps            = max(500, min(8000, pair_count * repeats * target_ep_steps))
        emit(f"PHASE Auto-computed {steps} training steps from {pair_count} pairs")

    # ── Derive max_seq_length from available VRAM ─────────────────────────────
    # Cards with ≤12 GB total VRAM cannot sustain 2048-token packed sequences
    # across 2 gradient accumulation steps without fragmentation-induced illegal
    # access errors mid-run.  Use 1024 on those cards; 2048 everywhere else.
    max_seq_length = 2048
    if device != "cpu":
        try:
            props      = torch.cuda.get_device_properties(0)
            total_gb   = props.total_memory / (1024 ** 3)
            if total_gb <= 12.0:
                max_seq_length = 1024
                emit(f"PHASE VRAM {total_gb:.1f} GB ≤ 12 GB — using max_seq_length=1024")
        except Exception:
            pass  # non-CUDA path or query failed — keep 2048

    # ── Load model via unsloth ────────────────────────────────────────────────
    emit(f"PHASE Downloading/loading {training_hf_id} (4-bit quantized)")

    load_dtype = None  # unsloth auto-selects based on mixed_precision
    if mixed_precision == "bf16":
        load_dtype = "bfloat16"

    try:
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name          = training_hf_id,
            max_seq_length      = max_seq_length,
            dtype               = None,          # auto
            load_in_4bit        = load_in_4bit,
            # ROCm single-GPU: force {"": 0} to prevent device_map="auto" from
            # trying to split the model when the HIP layer reports multiple logical
            # devices. CUDA and CPU use "auto" (correct for those paths).
            device_map          = {"": 0} if vendor == "rocm" else ("auto" if device == "cuda:0" else device),
        )
    except Exception as e:
        emit(f"ERROR Failed to load base model: {e}")
        sys.exit(1)

    # ── Apply LoRA ────────────────────────────────────────────────────────────
    emit(f"PHASE Applying LoRA rank={rank}")

    try:
        model = FastLanguageModel.get_peft_model(
            model,
            r                   = rank,
            target_modules      = ["q_proj", "k_proj", "v_proj", "o_proj",
                                   "gate_proj", "up_proj", "down_proj"],
            lora_alpha          = rank * 2,
            lora_dropout        = 0.0,           # unsloth recommends 0
            bias                = "none",
            use_gradient_checkpointing = "unsloth",
            random_state        = 42,
        )
    except Exception as e:
        emit(f"ERROR Failed to apply LoRA: {e}")
        sys.exit(1)

    # ── Load dataset ──────────────────────────────────────────────────────────
    emit("PHASE Loading preprocessed dataset")

    records = []
    with open(preprocessed_jsonl, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if not records:
        emit("ERROR Preprocessed JSONL is empty")
        sys.exit(1)

    # Format into text strings using the model's chat template
    def _format(example: dict) -> dict:
        try:
            text = tokenizer.apply_chat_template(
                example["messages"],
                tokenize          = False,
                add_generation_prompt = False,
            )
        except Exception:
            # Fallback: naive concat
            parts = [f"{m['role']}: {m['content']}" for m in example.get("messages", [])]
            text  = "\n".join(parts)
        return {"text": text}

    dataset = Dataset.from_list(records).map(_format, batched=False)

    # ── Training ──────────────────────────────────────────────────────────────
    emit("PHASE Training")

    batch_size        = 1
    grad_accum_steps  = 2   # 4 caused CUDA illegal access at ~600 steps on 10 GB cards

    training_args = SFTConfig(
        output_dir                  = str(output_dir),
        max_steps                   = steps,
        per_device_train_batch_size = batch_size,
        gradient_accumulation_steps = grad_accum_steps,
        learning_rate               = lr,
        lr_scheduler_type           = "cosine",
        warmup_ratio                = 0.05,
        optim                       = optim,
        bf16                        = (mixed_precision == "bf16"),
        fp16                        = (mixed_precision == "fp16"),
        logging_steps               = 10,
        save_steps                  = max(100, steps // 8),
        save_total_limit            = 3,
        resume_from_checkpoint      = resume_from,
        dataset_text_field          = "text",
        packing                     = True,    # pack multiple short examples — faster
        report_to                   = "none",  # no wandb/tensorboard
        dataloader_num_workers      = 0,
        seed                        = 42,
    )

    trainer = SFTTrainer(
        model      = model,
        tokenizer  = tokenizer,
        train_dataset = dataset,
        args          = training_args,
    )

    # Monkey-patch the log method to emit STEP lines to stdout
    _orig_log = trainer.log
    def _patched_log(logs: dict, *args, **kwargs) -> None:
        _orig_log(logs, *args, **kwargs)
        step  = trainer.state.global_step
        total = trainer.state.max_steps
        loss  = logs.get("loss", logs.get("train_loss", 0.0))
        emit(f"STEP {step}/{total} loss={loss:.4f}")
        # Return cached-but-freed CUDA blocks to the driver every 100 steps.
        # Prevents allocator fragmentation from accumulating into an illegal
        # memory access on long runs (observed at ~600/8000 steps on 10 GB cards).
        if device != "cpu" and step % 100 == 0:
            torch.cuda.empty_cache()
    trainer.log = _patched_log  # type: ignore[method-assign]

    try:
        trainer.train(resume_from_checkpoint=resume_from)
    except KeyboardInterrupt:
        emit("ERROR Training interrupted")
        sys.exit(1)
    except Exception as e:
        emit(f"ERROR Training failed: {e}")
        sys.exit(1)

     # ── Save LoRA safetensors + export GGUF via unsloth ──────────────────────
    emit("PHASE Saving LoRA weights")

    safetensors_path = output_dir / "lora.safetensors"
    try:
        model.save_pretrained(str(output_dir / "lora_adapter"))
        tokenizer.save_pretrained(str(output_dir / "lora_adapter"))
        adapter_file = output_dir / "lora_adapter" / "adapter_model.safetensors"
        if adapter_file.exists():
            import shutil
            shutil.copy2(str(adapter_file), str(safetensors_path))
        else:
            emit("ERROR adapter_model.safetensors not found after save")
            sys.exit(1)
    except Exception as e:
        emit(f"ERROR Failed to save LoRA weights: {e}")
        sys.exit(1)

    # ── Convert to GGUF ───────────────────────────────────────────────────────
    emit("PHASE Converting to GGUF")

    gguf_path     = output_dir / "lora.gguf"
    merged_dir    = output_dir / "merged_fp16"
    try:
        emit("PHASE Merging LoRA into base weights (fp16)")
        model.save_pretrained_merged(
            str(merged_dir),
            tokenizer,
            save_method = "merged_16bit",
        )
    except Exception as e:
        emit(f"ERROR Failed to merge LoRA weights: {e}")
        sys.exit(1)

    conversion_ok = _convert_lora_to_gguf(
        safetensors_path = safetensors_path,
        lora_adapter_dir = merged_dir,
        base_model_hf_id = training_hf_id,
        output_gguf_path = gguf_path,
    )
    if not conversion_ok or not gguf_path.exists():
        emit("ERROR GGUF conversion failed — lora.gguf not produced")
        sys.exit(1)

    # Clean up merged fp16 dir — several GB, not needed after GGUF conversion
    import shutil as _shutil
    if merged_dir.exists():
        _shutil.rmtree(str(merged_dir), ignore_errors=True)

    emit(f"DONE {safetensors_path} {gguf_path}")


def _convert_lora_to_gguf(
    safetensors_path: Path,
    lora_adapter_dir: Path,
    base_model_hf_id: str,
    output_gguf_path: Path,
) -> bool:
    """
    Converts lora.safetensors to lora.gguf using llama.cpp's
    convert_lora_to_gguf.py.  Searches for the converter in:
      1. LLAMA_CPP_DIR env var
      2. Alongside this script (dist/ or project root)
      3. Common build paths
    """
    converter = _find_llama_converter()
    if converter is None:
        emit("ERROR convert_hf_to_gguf.py not found. "
             "Set LLAMA_CPP_DIR env var to your llama.cpp directory.")
        return False

    # The converter takes --base as the HF model ID (it will download if needed)
    # or a local path to the base model safetensors.
    cmd = [
        sys.executable,
        str(converter),
        "--outfile", str(output_gguf_path),
        "--outtype", "q8_0",
        str(lora_adapter_dir),
    ]

    emit(f"PHASE Running GGUF converter")
    try:
        result = subprocess.run(
            cmd,
            capture_output = True,
            text           = True,
            timeout        = 20 * 60,
            env            = {**os.environ, "HF_HUB_ENABLE_HF_TRANSFER": "0"},
        )
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip().split("\n")[-5:]
            emit(f"ERROR Converter exited {result.returncode}: {' | '.join(tail)}")
            return False
        return True
    except subprocess.TimeoutExpired:
        emit("ERROR GGUF conversion timed out (20 min limit)")
        return False
    except Exception as e:
        emit(f"ERROR Converter subprocess error: {e}")
        return False


def _find_llama_converter() -> Path | None:
    """Locate convert_hf_to_gguf.py."""
    candidates: list[Path] = []

    if env_dir := os.environ.get("LLAMA_CPP_DIR"):
        candidates.append(Path(env_dir) / "convert_hf_to_gguf.py")

    script_dir = Path(__file__).resolve().parent
    for check_dir in [script_dir, script_dir.parent, script_dir.parent / "llamacpp"]:
        candidates.append(check_dir / "convert_hf_to_gguf.py")

    home = Path.home()
    for build in [
        home / ".phobos" / "llamacpp",
        home / "llama.cpp",
        Path("/usr/local/lib/llama.cpp"),
    ]:
        candidates.append(build / "convert_hf_to_gguf.py")

    for c in candidates:
        if c.exists():
            return c
    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args    = build_parser().parse_args()
    session = load_session(args.session_file)
    train(session)


if __name__ == "__main__":
    main()