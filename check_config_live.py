import torch
from diffusers import ChromaTransformer2DModel, GGUFQuantizationConfig

model_path = r"C:\Users\armyo\.phobos\models\image\flux\Chroma1-HD-Q4_0.gguf"

print("Loading GGUF model with lodestones/Chroma1-HD config...")
m = ChromaTransformer2DModel.from_single_file(
    model_path,
    quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
    torch_dtype=torch.bfloat16,
    config="lodestones/Chroma1-HD",
    subfolder="transformer",
)

print("\n=== Model config ===")
for k, v in m.config.to_dict().items():
    print(f"  {k}: {v}")

print("\n=== Key submodule params ===")
print("inner_dim:", m.inner_dim)
b0 = m.transformer_blocks[0]
print("transformer_blocks[0].attn.heads:", b0.attn.heads)
print("transformer_blocks[0].attn.dim_head:", b0.attn.inner_dim // b0.attn.heads if hasattr(b0.attn, 'inner_dim') else 'N/A')
print("transformer_blocks[0].attn.to_q:", b0.attn.to_q)
print("transformer_blocks[0].attn query_dim (to_q input):", b0.attn.to_q.weight.shape[1])
print("transformer_blocks[0].attn inner_dim (to_q output):", b0.attn.to_q.weight.shape[0])
