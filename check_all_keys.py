import glob, os
import safetensors.torch

d = r"C:\Users\armyo\.phobos\models\image\pytorch\chroma-q4\transformer"
all_keys = []
for s in sorted(glob.glob(os.path.join(d, "*.safetensors"))):
    for k, v in safetensors.torch.load_file(s, device="cpu").items():
        all_keys.append((k, list(v.shape)))

# Print unique key patterns (just first block index variants)
seen_patterns = set()
for k, shape in sorted(all_keys):
    # Normalize block indices to 0
    import re
    pattern = re.sub(r'\.\d+\.', '.N.', k)
    if pattern not in seen_patterns:
        seen_patterns.add(pattern)
        print(k, shape)
