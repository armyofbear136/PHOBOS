import glob, os, json
import safetensors.torch

d = r"C:\Users\armyo\.phobos\models\image\pytorch\chroma-q4\transformer"
keys_of_interest = ["x_embedder", "proj_out", "norm_out"]
shapes = {}
for s in sorted(glob.glob(os.path.join(d, "*.safetensors"))):
    for k, v in safetensors.torch.load_file(s, device="cpu").items():
        if any(x in k for x in keys_of_interest):
            shapes[k] = list(v.shape)
for k in sorted(shapes):
    print(k, shapes[k])
