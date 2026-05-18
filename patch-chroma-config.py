"""
patch-chroma-config.py — Derive correct ChromaTransformer2DModel config
from actual saved safetensors weight shapes and rewrite config.json.
"""

import json, os, glob, sys

try:
    import safetensors.torch as st_torch
except ImportError:
    print("ERROR: safetensors not installed"); sys.exit(1)

transformer_dir = os.path.join(
    os.path.expanduser("~"), ".phobos", "models", "image", "pytorch", "chroma-q4", "transformer"
)

if not os.path.isdir(transformer_dir):
    print(f"ERROR: not found: {transformer_dir}"); sys.exit(1)

shards = sorted(glob.glob(os.path.join(transformer_dir, "*.safetensors")))
if not shards:
    print(f"ERROR: no shards in {transformer_dir}"); sys.exit(1)

shapes = {}
for shard in shards:
    tensors = st_torch.load_file(shard, device="cpu")
    for k, v in tensors.items():
        shapes[k] = list(v.shape)
    del tensors

print(f"Loaded {len(shapes)} tensor shapes from {len(shards)} shard(s)")

def sh(key):
    if key not in shapes:
        raise KeyError(f"tensor not found: {key}")
    return shapes[key]

# in_channels: x_embedder input dim (patch embedding)
in_channels = sh("x_embedder.weight")[1]

# attention dims
head_dim  = 128
num_heads = sh("transformer_blocks.0.attn.to_q.weight")[0] // head_dim

# joint_attention_dim: context_embedder input dim
joint_attn_dim = sh("context_embedder.weight")[1]

# block counts
num_layers        = sum(1 for k in shapes if k.startswith("transformer_blocks.")
                        and k.endswith(".attn.to_q.weight"))
num_single_layers = sum(1 for k in shapes if k.startswith("single_transformer_blocks.")
                        and k.endswith(".attn.to_q.weight"))

# approximator (distilled_guidance_layer):
# in_proj.weight shape: [approx_hidden_dim, approx_num_channels]
# diffusers builds: in_proj = Linear(approximator_num_channels, approximator_hidden_dim)
# so in_proj.weight rows = approx_hidden_dim, cols = approximator_num_channels
approx_hidden_dim    = sh("distilled_guidance_layer.in_proj.weight")[0]
approx_num_channels  = sh("distilled_guidance_layer.in_proj.weight")[1]  # = in_channels = 128

# approximator_layers: count of MLP depth layers (layers.0 .. layers.N)
approx_layers = sum(1 for k in shapes
                    if k.startswith("distilled_guidance_layer.layers.")
                    and k.endswith(".linear_1.weight"))

print(f"\nDerived architecture:")
print(f"  in_channels            : {in_channels}")
print(f"  num_attention_heads    : {num_heads}")
print(f"  attention_head_dim     : {head_dim}")
print(f"  joint_attention_dim    : {joint_attn_dim}")
print(f"  num_layers             : {num_layers}")
print(f"  num_single_layers      : {num_single_layers}")
print(f"  approximator_hidden_dim: {approx_hidden_dim}")
print(f"  approximator_layers    : {approx_layers}")
print(f"  approximator_num_chans : {approx_num_channels}")

cfg = {
    "_class_name": "ChromaTransformer2DModel",
    "_diffusers_version": "0.35.1",
    "approximator_hidden_dim": approx_hidden_dim,
    "approximator_layers": approx_layers,
    "approximator_num_channels": approx_num_channels,
    "attention_head_dim": head_dim,
    "axes_dims_rope": [16, 56, 56],
    "guidance_embeds": False,
    "in_channels": in_channels,
    "joint_attention_dim": joint_attn_dim,
    "num_attention_heads": num_heads,
    "num_layers": num_layers,
    "num_single_layers": num_single_layers,
    "out_channels": None,
    "patch_size": 1,
    "pooled_projection_dim": 768,
}

cfg_path = os.path.join(transformer_dir, "config.json")
with open(cfg_path) as f:
    old_cfg = json.load(f)

with open(cfg_path, "w") as f:
    json.dump(cfg, f, indent=2)

print(f"\nDiffs from previous config.json:")
changed = False
for k in sorted(set(list(old_cfg.keys()) + list(cfg.keys()))):
    old_v = old_cfg.get(k, "<missing>")
    new_v = cfg.get(k, "<removed>")
    if old_v != new_v:
        print(f"  {k}: {old_v} -> {new_v}")
        changed = True
if not changed:
    print("  (no changes)")

print(f"\nWrote {cfg_path}")