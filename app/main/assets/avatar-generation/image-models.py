"""List ComfyUI's configured weights and classify supported image and 3D architectures without loading them."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "comfyui-aiembodied"))
from aiembodied_model_kinds import scan, signature, trellis_kind  # noqa: E402,F401  (signature and trellis_kind are re-exported for tests)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-dir", required=True)
    parser.add_argument("--model-paths")
    args = parser.parse_args()
    sys.path.insert(0, str(Path(args.comfy_dir).resolve()))
    import folder_paths
    if args.model_paths:
        from utils.extra_config import load_extra_path_config
        load_extra_path_config(args.model_paths)
    print(json.dumps(scan(folder_paths)))


if __name__ == "__main__":
    main()
