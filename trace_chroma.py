import torch
from diffusers import ChromaTransformer2DModel, GGUFQuantizationConfig
import torch.nn as nn

model_path = r"C:\Users\armyo\.phobos\models\image\flux\Chroma1-HD-Q4_0.gguf"

_orig_linear_fwd = nn.Linear.forward
_orig_rms_fwd = nn.RMSNorm.forward

def traced_linear(self, x):
    out = _orig_linear_fwd(self, x)
    print(f"  Linear  in={tuple(x.shape)}  weight={tuple(self.weight.shape)}  out={tuple(out.shape)}")
    return out

def traced_rms(self, x):
    out = _orig_rms_fwd(self, x)
    print(f"  RMSNorm in={tuple(x.shape)}  out={tuple(out.shape)}")
    return out

import diffusers.models.transformers.transformer_chroma as tc
_orig_approx_fwd = tc.ChromaApproximator.forward

def traced_approx(self, x):
    print(f"\n=== ChromaApproximator.forward  input={tuple(x.shape)} ===")
    nn.Linear.forward = traced_linear
    nn.RMSNorm.forward = traced_rms
    try:
        out = _orig_approx_fwd(self, x)
    finally:
        nn.Linear.forward = _orig_linear_fwd
        nn.RMSNorm.forward = _orig_rms_fwd
    print(f"=== ChromaApproximator.forward  output={tuple(out.shape)} ===\n")
    return out

tc.ChromaApproximator.forward = traced_approx

print("Loading model (GGUF dequant, config from lodestones/Chroma1-HD)...")
m = ChromaTransformer2DModel.from_single_file(
    model_path,
    quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
    torch_dtype=torch.bfloat16,
    config="lodestones/Chroma1-HD",
    subfolder="transformer",
)
m.eval()

print("\nRunning forward pass with dummy timestep...")
with torch.no_grad():
    t = torch.tensor([0.5], dtype=torch.bfloat16)
    input_vec = m.time_text_embed(t)
    print(f"time_text_embed output shape: {tuple(input_vec.shape)}")
    _ = m.distilled_guidance_layer(input_vec)