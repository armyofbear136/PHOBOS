"""
phobos-voice-extract.py — PHOBOS WeClone voice profile extractor.

One-shot script. Accepts a reference WAV, validates quality, extracts a
192-dim ECAPA-TDNN speaker embedding and an MFCC FAISS index, writes
profile.json + index.faiss + ref.wav to --output-dir.

Progress protocol (same as all PHOBOS Python scripts):
  [INFO ] <message>   — forwarded to onProgress in AudioServerManager
  [ERROR] <message>   — fatal; script exits 1 after printing this

Usage:
  python phobos-voice-extract.py \\
      --ref-audio  /path/to/ref.wav \\
      --name       "My Voice" \\
      --output-dir ~/.phobos/voice-profiles/<uuid>/ \\
      --device     cpu \\
      [--ref-text  "optional transcript"]
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import uuid
from pathlib import Path

# ── speechbrain optional-integration patch ───────────────────────────────────
# speechbrain 1.1.0 registers lazy modules for every optional integration
# (k2_fsa, huggingface.wordemb, nlp, numba, etc.) via lazy_export_all() at
# package init time. When transformers/torch internals call hasattr() or dir()
# on the speechbrain module tree during model loading, LazyModule.__getattr__
# fires and tries importlib.import_module on each target. Any that require
# optional packages (k2, spacy, flair, numba…) raise ImportError.
#
# Fix: monkeypatch LazyModule.ensure_module so that ImportError on a missing
# optional integration returns a harmless empty stub instead of raising.
# This must run before any 'import speechbrain' statement.
def _patch_speechbrain_lazy_imports() -> None:
    import importlib

    # Pre-register stubs for all known optional integrations so sys.modules
    # lookups never reach ensure_module at all for these packages.
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

    # Belt-and-suspenders: also patch LazyModule.ensure_module so any lazy
    # module not in the pre-registered list above silently returns a stub
    # instead of raising ImportError when the optional package is absent.
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
        pass  # If speechbrain isn't importable yet, the pre-registration above is sufficient

_patch_speechbrain_lazy_imports()

# ── CLI ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument('--ref-audio',   required=True)
    p.add_argument('--name',        required=True)
    p.add_argument('--output-dir',  required=True)
    p.add_argument('--device',      default='cpu')
    p.add_argument('--ref-text',    default=None)
    # whisper-cli path — resolved from the same dir as this script if not provided
    p.add_argument('--whisper-bin', default=None)
    return p.parse_args()


def info(msg: str) -> None:
    print(f'[INFO ] {msg}', flush=True)

def error(msg: str) -> None:
    print(f'[ERROR] {msg}', flush=True)


# ── Audio validation ──────────────────────────────────────────────────────────

def validate_and_prepare(ref_audio: str) -> tuple[object, int]:
    """
    Returns (audio_tensor [1, T], sample_rate).
    Resamples to 16kHz mono, trims to 120s, validates duration and SNR.
    """
    import torch
    import torchaudio

    waveform, sr = torchaudio.load(ref_audio)

    # Downmix to mono
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)

    # Resample to 16kHz
    if sr != 16000:
        waveform = torchaudio.functional.resample(waveform, sr, 16000)
        sr = 16000

    # Trim to 120s max
    max_samples = 120 * sr
    if waveform.shape[1] > max_samples:
        info('Reference clip exceeds 120s — trimming to first 120s')
        waveform = waveform[:, :max_samples]

    duration = waveform.shape[1] / sr
    if duration < 8.0:
        raise ValueError(f'Reference clip is {duration:.1f}s — minimum is 8s for reliable extraction')

    # SNR estimate: ratio of voiced-frame energy to silence-frame energy
    frame_size = int(0.025 * sr)  # 25ms frames
    frames = waveform[0].unfold(0, frame_size, frame_size)
    energy = frames.pow(2).mean(dim=1)
    sorted_e, _ = energy.sort()
    n = len(sorted_e)
    noise_floor = sorted_e[:max(1, n // 10)].mean().item()
    signal_peak = sorted_e[n * 9 // 10 :].mean().item()
    snr_db = 10 * (torch.tensor(signal_peak + 1e-10) / torch.tensor(noise_floor + 1e-10)).log10().item()

    if snr_db < 8.0:
        raise ValueError(f'Reference SNR {snr_db:.1f} dB is below 8 dB minimum — clip is too noisy')
    if snr_db < 15.0:
        info(f'Reference SNR {snr_db:.1f} dB is low — proceed with caution')
    else:
        info(f'Reference SNR {snr_db:.1f} dB — OK')

    # Peak normalise to -3 dBFS
    peak = waveform.abs().max().item()
    if peak > 0:
        target = 10 ** (-3.0 / 20.0)
        waveform = waveform * (target / peak)

    return waveform, sr, duration, snr_db


# ── Speaker embedding — ECAPA-TDNN direct load ───────────────────────────────
#
# speechbrain 1.1.0 registers speechbrain.integrations.k2_fsa as a lazy
# export at package init time. The from_hparams / YAML pipeline loader
# triggers __getattr__ on that lazy module, causing an ImportError because
# k2 is not installed. Bypassing from_hparams entirely by loading the ECAPA
# checkpoint directly avoids that code path entirely.
#
# spkrec-ecapa-voxceleb uses:
#   - 80-dim log-Mel filterbank (Fbank, 25ms window / 10ms hop, 16kHz)
#   - ECAPA_TDNN(input_size=80, lin_neurons=192, channels=[512,512,512,512,1536])
#   - Mean-variance normalisation before embedding_model
# These are the values from the model's hyperparams.yaml and match the
# published checkpoint exactly.

def extract_embedding(waveform: object, sr: int, device: str) -> list:
    """Returns 192-dim speaker embedding as a plain float list."""
    import torch
    from huggingface_hub import hf_hub_download
    from speechbrain.lobes.features import Fbank
    from speechbrain.lobes.models.ECAPA_TDNN import ECAPA_TDNN
    from speechbrain.processing.features import InputNormalization

    info('Loading ECAPA-TDNN speaker encoder')

    # Download checkpoint (cached after first run in ~/.cache/huggingface/hub)
    ckpt_path = hf_hub_download(
        repo_id='speechbrain/spkrec-ecapa-voxceleb',
        filename='embedding_model.ckpt',
    )

    # Feature extractor — 80-dim log-Mel, 16kHz
    fbank = Fbank(n_mels=80, sample_rate=sr).to(device)

    # Encoder — architecture matches the large spkrec-ecapa-voxceleb checkpoint.
    # channels=[1024,1024,1024,1024,3072] confirmed from checkpoint shapes:
    #   blocks.0.conv.conv.weight: [1024, 80, 5]
    #   mfa.conv.conv.weight:      [3072, 3072, 1]
    #   fc.conv.weight:            [192, 6144, 1]  (6144 = 2×3072, global_context=True)
    encoder = ECAPA_TDNN(
        input_size=80,
        device=device,
        lin_neurons=192,
        channels=[1024, 1024, 1024, 1024, 3072],
        kernel_sizes=[5, 3, 3, 3, 1],
        dilations=[1, 2, 3, 4, 1],
    ).to(device)

    # Load checkpoint — speechbrain saves as an OrderedDict of param tensors
    state = torch.load(ckpt_path, map_location=device, weights_only=True)
    # speechbrain checkpoints may be wrapped under a top-level key
    if isinstance(state, dict) and '0' in state:
        state = state['0']
    encoder.load_state_dict(state, strict=False)
    encoder.eval()

    # Mean-variance normalisation over the batch (single utterance)
    normaliser = InputNormalization(norm_type='sentence', std_norm=False).to(device)

    wav = waveform.squeeze(0).unsqueeze(0).to(device)  # [1, T]
    wav_lens = torch.ones(1, device=device)

    with torch.no_grad():
        feats = fbank(wav)                              # [1, T', 80]
        feats = normaliser(feats, wav_lens)
        embedding = encoder(feats, wav_lens)            # [1, 1, 192]

    return embedding.squeeze().tolist()


# ── MFCC features + FAISS index ──────────────────────────────────────────────
#
# 40-coefficient MFCCs at 25ms/10ms window/hop on the reference clip.
# No model to load — pure torchaudio signal processing. Each frame is one
# row in a FAISS flat L2 index. Extraction is <1s regardless of clip length.
# The convert daemon uses the same MFCC parameters to extract features from
# the Kokoro output, then retrieves the k nearest reference frames to blend
# speaker timbre into the synthesis.

def build_mfcc_index(waveform: object, sr: int, output_dir: Path) -> None:
    """Extracts 40-dim MFCC frames and writes a FAISS flat L2 index."""
    import numpy as np
    import torch
    import torchaudio
    import faiss

    info('Building MFCC speaker index')

    mfcc_transform = torchaudio.transforms.MFCC(
        sample_rate=sr,
        n_mfcc=40,
        melkwargs={
            'n_fft':     int(sr * 0.025),   # 25ms window
            'hop_length': int(sr * 0.010),  # 10ms hop
            'n_mels':    80,
        },
    )

    # waveform: [1, T] — MFCC expects [channel, time], returns [channel, n_mfcc, frames]
    with torch.no_grad():
        features = mfcc_transform(waveform)  # [1, 40, F]
    features = features.squeeze(0).T.numpy().astype(np.float32)  # [F, 40]

    info(f'Extracted {features.shape[0]} MFCC frames (40-dim)')

    index = faiss.IndexFlatL2(features.shape[1])
    index.add(features)
    faiss.write_index(index, str(output_dir / 'index.faiss'))
    info(f'FAISS index built ({index.ntotal} vectors)')


# ── Transcription ─────────────────────────────────────────────────────────────

def transcribe_ref(ref_audio: str, whisper_bin: str | None) -> str:
    """Runs whisper-cli on the reference audio and returns the transcript."""
    # Resolve whisper-cli alongside this script or in PATH
    if whisper_bin is None:
        script_dir = Path(__file__).parent
        for candidate in [
            script_dir / 'whisper-cli.exe',
            script_dir / 'whisper-cli',
            script_dir.parent / 'dist' / 'whisper-cli.exe',
            script_dir.parent / 'dist' / 'whisper-cli',
        ]:
            if candidate.exists():
                whisper_bin = str(candidate)
                break

    # Resolve whisper model
    whisper_model = None
    phobos_models = Path.home() / '.phobos' / 'models' / 'audio' / 'whisper' / 'whisper-large-v3'
    for candidate in [phobos_models / 'ggml-large-v3.bin']:
        if candidate.exists():
            whisper_model = str(candidate)
            break

    if whisper_bin is None or whisper_model is None:
        info('whisper-cli or model not found — skipping transcription')
        return ''

    with tempfile.NamedTemporaryFile(suffix='.txt', delete=False) as tmp:
        txt_path = tmp.name

    try:
        result = subprocess.run(
            [whisper_bin, '--model', whisper_model, '--file', ref_audio,
             '--output-txt', '--no-timestamps'],
            capture_output=True, text=True, timeout=120,
        )
        expected = ref_audio + '.txt'
        if os.path.exists(expected):
            text = Path(expected).read_text(encoding='utf8').strip()
            os.unlink(expected)
            return text
        return result.stdout.strip()
    except Exception as exc:
        info(f'Transcription failed (non-fatal): {exc}')
        return ''
    finally:
        try: os.unlink(txt_path)
        except: pass


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    t0 = time.time()
    args = parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Profile ID is the directory name — set by AudioServerManager before spawn
    profile_id = output_dir.name

    try:
        info('Validating reference audio')
        waveform, sr, duration, snr_db = validate_and_prepare(args.ref_audio)

        # Save normalised reference clip
        import torchaudio
        torchaudio.save(str(output_dir / 'ref.wav'), waveform, sr)

        # Transcription
        ref_text = args.ref_text or ''
        if not ref_text:
            info('Transcribing reference clip')
            ref_text = transcribe_ref(args.ref_audio, args.whisper_bin)

        # Speaker embedding
        info('Extracting speaker embedding')
        embedding = extract_embedding(waveform, sr, args.device)

        # MFCC FAISS index
        info('Building speaker index')
        build_mfcc_index(waveform, sr, output_dir)

        # Write profile.json
        info('Writing profile')
        profile = {
            'id':             profile_id,
            'name':           args.name,
            'createdAt':      __import__('datetime').datetime.utcnow().isoformat() + 'Z',
            'durationSec':    round(duration, 2),
            'sampleRate':     sr,
            'snrDb':          round(snr_db, 2),
            'embedding':      embedding,
            'refText':        ref_text,
            'extractVersion': '1.0.0',
        }
        (output_dir / 'profile.json').write_text(json.dumps(profile, indent=2), encoding='utf8')

        elapsed = time.time() - t0
        info(f'Done — profile {profile_id} ({elapsed:.1f}s total)')

    except Exception as exc:
        error(str(exc))
        sys.exit(1)


if __name__ == '__main__':
    main()