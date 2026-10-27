"""Build a TEXT_ENCODERS_DIR with a pre-merged LLM2Vec mntp checkpoint (works for both ARDY and Kimodo).

  .venv-kimodo\\Scripts\\python scripts\\build_text_encoder.py --out D:\\models\\text_encoders_merged \\
      [--base meta-llama/Meta-Llama-3-8B-Instruct | NousResearch/Meta-Llama-3-8B-Instruct | <local dir>]

Run it in the **Kimodo** venv. Its transformers (5.1) can still resolve the mntp adapter's base
model, which ARDY's (5.8) cannot; that is the reason for pre-merging. Needs about 32 GB of RAM and
15 GB of disk.
"""

import argparse
import json
import shutil
import tempfile
from pathlib import Path

MNTP = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp"
SUPERVISED = "McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised"
PATTERNS = ["*.json", "*.safetensors", "*.md"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--base", default="meta-llama/Meta-Llama-3-8B-Instruct",
                    help="HF repo id or local folder of Llama-3-8B-Instruct (official repo is gated)")
    a = ap.parse_args()

    import torch
    from huggingface_hub import snapshot_download
    from kimodo.model.llm2vec.llm2vec import LLM2Vec

    base = Path(a.base) if Path(a.base).is_dir() else Path(snapshot_download(a.base, allow_patterns=PATTERNS))
    with tempfile.TemporaryDirectory() as tmp:
        mntp = Path(tmp) / "mntp"
        shutil.copytree(snapshot_download(MNTP, allow_patterns=PATTERNS), mntp)
        cfg = json.loads((mntp / "adapter_config.json").read_text())
        cfg["base_model_name_or_path"] = str(base)
        (mntp / "adapter_config.json").write_text(json.dumps(cfg, indent=2))

        m = LLM2Vec.from_pretrained(str(mntp), torch_dtype=torch.bfloat16)  # loads base + merges the mntp LoRA
        model = m.model
        model._hf_peft_config_loaded = False  # stale flag; weights are merged, save the full model
        dst = a.out / MNTP
        dst.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(dst, safe_serialization=True)
        m.tokenizer.save_pretrained(dst)
    cfg = json.loads((dst / "config.json").read_text())
    cfg["_name_or_path"] = "meta-llama/Meta-Llama-3-8B-Instruct"  # LLM2Vec picks the Llama-3 template from this
    (dst / "config.json").write_text(json.dumps(cfg, indent=2))
    shutil.copytree(snapshot_download(SUPERVISED, allow_patterns=PATTERNS), a.out / SUPERVISED, dirs_exist_ok=True)
    print(f"done: set TEXT_ENCODERS_DIR={a.out}")


if __name__ == "__main__":
    main()
