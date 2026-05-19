import glob, os, json
import safetensors.torch

d = r"C:\Users\armyo\.phobos\models\image\pytorch\chroma-q4\transformer"
shapes = {}
for s in sorted(glob.glob(os.path.join(d, "*.safetensors"))):
    for k, v in safetensors.torch.load_file(s, device="cpu").items():
        if "transformer_blocks.0.attn" in k or "context_embedder" in k:
            shapes[k] = list(v.shape)
for k in sorted(shapes):
    print(k, shapes[k])

print()
with open(os.path.join(d, "config.json")) as f:
    cfg = json.load(f)
print("joint_attention_dim:", cfg.get("joint_attention_dim"))
print("num_attention_heads:", cfg.get("num_attention_heads"))
print("attention_head_dim:", cfg.get("attention_head_dim"))
print("inner_dim = heads*head_dim:", cfg.get("num_attention_heads", 0) * cfg.get("attention_head_dim", 0))
