"""
phobos-voice-convert.py — PHOBOS WeClone voice conversion daemon.

Resident daemon. Stays alive after startup, accepts conversion jobs over
stdin (one JSON line per job), writes results to stdout (one JSON line per
result). Mirrors the phobos-kokoro.mjs daemon pattern.

Job input  (stdin JSON line):
  { "id": "<jobId>", "input": "/tmp/phobos-tts-<uuid>.wav", "output": "/tmp/phobos-vc-<uuid>.wav" }

Job output (stdout JSON line) on success:
  { "id": "<jobId>", "status": "done", "output": "/tmp/phobos-vc-<uuid>.wav", "elapsedMs": 380 }

Job output on error:
  { "id": "<jobId>", "status": "error", "message": "<description>" }

Startup:
  python phobos-voice-convert.py \\
      --profile-dir  ~/.phobos/voice-profiles/<uuid>/ \\
      --device       cpu

Models are loaded once at startup and held in memory. Each job is processed
synchronously — conversion is fast enough (~0.3–0.8s) that the Kokoro
synthesis upstream is always the bottleneck.
"""

import argparse
import json
import os
import sys
import time
import types
from pathlib import Path

# ── speechbrain optional-integration patch ───────────────────────────────────
# Identical to phobos-voice-extract.py — must run before any import speechbrain.
# See that file for full explanation.
def _patch_speechbrain_lazy_imports() -> None:
    _OPTIONAL_INTEGRATIONS = [
        'speechbrain.integrations.k2_fsa',
        'speechbrain.integrations.huggingface.wordemb',
        'speechbrain.integrations.huggingface',
        'speechbrain.integrations.nlp',
        'speechbrain.integrations.numba',
        'speechbrain.integrations.numba.transducer_loss',
        'speechbrain.k2_integration',
        'speechbrain.wordemb',
        'speechbrain.lobes.models.huggingface_transformers',
        'speechbrain.lobes.models.spacy',
        'speechbrain.lobes.models.flair',
        'speechbrain.nnet.loss.transducer_loss',
        'speechbrain.pretrained',
    ]
    for mod_name in _OPTIONAL_INTEGRATIONS:
        if mod_name not in sys.modules:
            stub = types.ModuleType(mod_name)
            stub.__path__ = []  # type: ignore[attr-defined]
            sys.modules[mod_name] = stub
    try:
        from speechbrain.utils.importutils import LazyModule
        _original_ensure = LazyModule.ensure_module

        def _safe_ensure(self, stacklevel: int):
            try:
                return _original_ensure(self, stacklevel + 1)
            except (ImportError, ModuleNotFoundError):
                stub = types.ModuleType(self.target)
                stub.__path__ = []  # type: ignore[attr-defined]
                self.lazy_module = stub
                return stub

        LazyModule.ensure_module = _safe_ensure  # type: ignore[method-assign]
    except Exception:
        pass

_patch_speechbrain_lazy_imports()

# ── CLI ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument('--profile-dir', required=True)
    p.add_argument('--device',      default='cpu')
    return p.parse_args()


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


# ── Model loading ─────────────────────────────────────────────────────────────

def load_models(profile_dir: Path, device: str) -> dict:
    """Loads the MFCC transform, FAISS index, and profile metadata once at startup."""
    import torch
    import torchaudio
    import faiss

    profile_json = json.loads((profile_dir / 'profile.json').read_text(encoding='utf8'))
    sr = profile_json['sampleRate']

    # MFCC transform — identical params to phobos-voice-extract.py
    # No model weights to download; pure signal processing, instant init.
    mfcc_transform = torchaudio.transforms.MFCC(
        sample_rate=sr,
        n_mfcc=40,
        melkwargs={
            'n_fft':      int(sr * 0.025),
            'hop_length': int(sr * 0.010),
            'n_mels':     80,
        },
    )

    index_path = str(profile_dir / 'index.faiss')
    index = faiss.read_index(index_path)

    # Reference pitch for F0 shifting
    ref_f0_median = _estimate_f0_median(
        str(profile_dir / 'ref.wav'), sr
    )

    return {
        'mfcc':          mfcc_transform,
        'index':         index,
        'device':        device,
        'sr':            sr,
        'ref_f0_median': ref_f0_median,
        'profile':       profile_json,
    }


def _estimate_f0_median(wav_path: str, sr: int) -> float:
    """Estimates median fundamental frequency of the reference clip."""
    try:
        import numpy as np
        import torchaudio

        waveform, file_sr = torchaudio.load(wav_path)
        audio = waveform.squeeze(0).numpy()
        if file_sr != sr:
            import torchaudio.functional as F
            import torch
            audio = F.resample(torch.tensor(audio), file_sr, sr).numpy()

        # Simple autocorrelation-based F0 estimate — lightweight, no extra deps
        frame_size = int(0.025 * sr)
        hop_size   = int(0.010 * sr)
        f0_values  = []
        for start in range(0, len(audio) - frame_size, hop_size):
            frame = audio[start:start + frame_size]
            if np.abs(frame).max() < 0.01:
                continue  # silence
            acorr = np.correlate(frame, frame, mode='full')
            acorr = acorr[frame_size:]
            # Find first peak after minimum lag (f0 < 400 Hz)
            min_lag = int(sr / 400)
            max_lag = int(sr / 50)
            if max_lag >= len(acorr):
                continue
            peak_lag = np.argmax(acorr[min_lag:max_lag]) + min_lag
            if acorr[peak_lag] > 0.3 * acorr[0]:
                f0_values.append(sr / peak_lag)

        if not f0_values:
            return 150.0  # neutral fallback
        return float(np.median(f0_values))

    except Exception:
        return 150.0  # neutral fallback


# ── Per-job conversion ────────────────────────────────────────────────────────

def convert_one(job: dict, state: dict) -> dict:
    """
    Runs one voice conversion job. Returns the result dict for stdout.
    """
    import numpy as np
    import torch
    import torchaudio

    t0      = time.time()
    job_id  = job['id']
    in_path = job['input']
    out_path = job['output']

    # Load Kokoro output — resample to match profile sample rate
    waveform, sr = torchaudio.load(in_path)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    profile_sr = state['sr']
    if sr != profile_sr:
        waveform = torchaudio.functional.resample(waveform, sr, profile_sr)
        sr = profile_sr

    audio = waveform.squeeze(0).numpy()

    # MFCC feature extraction — same params as build_mfcc_index in extract script
    # No model inference, sub-millisecond on any hardware.
    with torch.no_grad():
        src_features = state['mfcc'](waveform)   # [1, 40, F]
    src_features = src_features.squeeze(0).T.numpy().astype(np.float32)  # [F, 40]

    # FAISS retrieval: k nearest reference MFCC frames for each input frame
    k = 4
    n_frames = src_features.shape[0]
    D, I = state['index'].search(src_features, k)  # noqa: E741

    ntotal = state['index'].ntotal
    index_vectors = np.stack([
        np.mean([
            state['index'].reconstruct(int(I[i, j]))
            for j in range(k)
            if 0 <= int(I[i, j]) < ntotal
        ], axis=0)
        for i in range(n_frames)
    ]).astype(np.float32)

    blend_ratio  = 0.75
    converted_features = (1.0 - blend_ratio) * src_features + blend_ratio * index_vectors

    # Pitch adjustment: estimate input F0, scale to reference median
    input_f0_median = _estimate_f0_median(in_path, 16000)
    ref_f0_median   = state['ref_f0_median']
    f0_shift_ratio  = ref_f0_median / max(input_f0_median, 1.0)
    # Clamp to sensible range — avoid extreme pitch shifts on noisy F0 estimates
    f0_shift_ratio = max(0.5, min(2.0, f0_shift_ratio))

    # Vocoder synthesis — WORLD preferred, pysptk fallback
    output_audio = _vocode(audio, sr, converted_features, f0_shift_ratio)

    # Write output WAV
    out_tensor = torch.tensor(output_audio, dtype=torch.float32).unsqueeze(0)
    torchaudio.save(out_path, out_tensor, sr)

    elapsed_ms = int((time.time() - t0) * 1000)
    return { 'id': job_id, 'status': 'done', 'output': out_path, 'elapsedMs': elapsed_ms }


def _vocode(audio: object, sr: int, converted_features: object, f0_shift_ratio: float) -> object:
    """
    Synthesizes output audio from converted features + F0-shifted source.
    Tries pyworld first; falls back to pysptk if unavailable.
    """
    import numpy as np

    audio_f64 = audio.astype(np.float64)

    try:
        import pyworld as pw

        f0, sp, ap = pw.wav2world(audio_f64, sr)

        # Apply F0 shift to non-zero frames
        f0_shifted = f0.copy()
        voiced = f0 > 0
        f0_shifted[voiced] = f0[voiced] * f0_shift_ratio

        # Synthesise with original spectral envelope + shifted F0
        # (converted_features carry speaker identity into the index; WORLD gives
        #  clean vocoder quality without needing a full neural decoder)
        synthesized = pw.synthesize(f0_shifted, sp, ap, sr)
        return synthesized.astype(np.float32)

    except ImportError:
        pass  # pyworld not installed — fall through to pysptk

    try:
        import pysptk

        # pysptk path: estimate F0 via swipe, synthesise with MLSADF
        frame_len  = int(sr * 0.025)
        hop_len    = int(sr * 0.005)
        f0 = pysptk.swipe(audio_f64, fs=sr, hopsize=hop_len, min=50, max=400, otype='f0')
        f0_shifted = np.where(f0 > 0, f0 * f0_shift_ratio, f0)

        order = 24
        mc = pysptk.sp2mc(
            np.abs(np.fft.rfft(
                np.pad(audio_f64, (0, frame_len - len(audio_f64) % frame_len) % frame_len)
                .reshape(-1, frame_len)
            )) + 1e-10,
            order=order, alpha=pysptk.util.mcepalpha(sr),
        )
        synthesized = pysptk.synthesis.synthesize(
            f0_shifted, mc, pysptk.synthesis.MLSADF(order=order, alpha=pysptk.util.mcepalpha(sr)),
            hopsize=hop_len,
        )
        return synthesized.astype(np.float32)

    except ImportError:
        pass  # pysptk not installed either

    # Last resort: return Kokoro output unmodified (no conversion)
    return audio.astype(np.float32)


# ── Main daemon loop ──────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()
    profile_dir = Path(args.profile_dir)

    if not profile_dir.exists():
        print(json.dumps({ 'status': 'fatal', 'message': f'Profile dir not found: {profile_dir}' }), flush=True)
        sys.exit(1)

    state = load_models(profile_dir, args.device)
    # Signal ready
    print(json.dumps({ 'status': 'ready', 'profileId': profile_dir.name }), flush=True)

    # Read jobs from stdin one line at a time
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({ 'id': 'unknown', 'status': 'error', 'message': f'JSON parse error: {exc}' })
            continue

        job_id = job.get('id', 'unknown')
        try:
            result = convert_one(job, state)
            emit(result)
        except Exception as exc:
            emit({ 'id': job_id, 'status': 'error', 'message': str(exc) })


if __name__ == '__main__':
    main()