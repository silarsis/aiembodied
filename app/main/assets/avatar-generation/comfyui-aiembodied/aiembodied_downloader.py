"""Download a model file into one of ComfyUI's model folders.

Used two ways:
- by the aiembodied ComfyUI add-on (this folder copied into ComfyUI/custom_nodes), which runs
  downloads for the app on that machine;
- as a script on this PC, run with ComfyUI's Python, which prints JSON progress lines:

    python aiembodied_downloader.py --comfy-dir C:/ComfyUI [--model-paths extra.yaml] \
        --folder checkpoints --filename model.safetensors --url https://... [--sha256 HEX]

  A Civitai key comes from the CIVITAI_TOKEN environment variable, never the command line.

Files are written to "<name>.part" and renamed only once complete (and, when a SHA-256 is given,
verified), so ComfyUI never lists a half-downloaded model.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid

# Folders the app may write to: ComfyUI's model folder names.
ALLOWED_FOLDERS = {
    "checkpoints", "loras", "vae", "embeddings", "controlnet", "upscale_models", "hypernetworks",
    "diffusion_models", "text_encoders", "clip_vision",
}
ALLOWED_SUFFIXES = (".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin")
CHUNK = 4 * 1024 * 1024


class DownloadError(Exception):
    pass


def safe_filename(name):
    """A plain file name with a model suffix: no folders, no drive letters, no traversal."""
    base = os.path.basename(str(name).replace("\\", "/")).strip()
    base = re.sub(r"[\x00-\x1f<>:\"|?*]", "_", base)
    if not base or base in (".", "..") or base.startswith("."):
        raise DownloadError("That file name can't be used.")
    if not base.lower().endswith(ALLOWED_SUFFIXES):
        raise DownloadError("Only model files (.safetensors, .gguf, .ckpt, .pt, .pth, .bin) can be downloaded.")
    return base


def check_url(url):
    parsed = urllib.parse.urlparse(str(url))
    if parsed.scheme != "https" or not parsed.netloc:
        raise DownloadError("Downloads must come from an https:// address.")
    return url


def with_civitai_token(url, token):
    """Civitai downloads take the API key as ?token=, which survives its redirect to storage."""
    if not token:
        return url
    parsed = urllib.parse.urlparse(url)
    if not re.search(r"(^|\.)civitai\.(com|green|red)$", parsed.hostname or ""):
        return url
    query = urllib.parse.parse_qsl(parsed.query)
    query = [(k, v) for k, v in query if k != "token"] + [("token", token)]
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))


def target_folder(folder, folder_paths=None):
    """ComfyUI's first path for a model folder."""
    if folder not in ALLOWED_FOLDERS:
        raise DownloadError(f"'{folder}' isn't a model folder the app downloads into.")
    if folder_paths is None:
        import folder_paths  # ComfyUI's module, importable inside ComfyUI or after --comfy-dir
    paths = folder_paths.get_folder_paths(folder)
    if not paths:
        raise DownloadError(f"ComfyUI has no '{folder}' folder.")
    return paths[0]


class Download:
    """One download's state. `run` does the work; the add-on runs it on a thread."""

    def __init__(self, url, directory, filename, sha256=None, token=None, opener=None):
        self.id = uuid.uuid4().hex
        self.url = check_url(url)
        self.directory = directory
        self.filename = safe_filename(filename)
        self.sha256 = (sha256 or "").lower() or None
        self.token = token
        self.opener = opener or urllib.request.urlopen
        self.state = "queued"  # queued, downloading, verifying, done, failed, cancelled
        self.received = 0
        self.total = None
        self.error = None
        self.started = time.time()
        self._cancel = threading.Event()

    @property
    def path(self):
        return os.path.join(self.directory, self.filename)

    def status(self):
        return {
            "id": self.id,
            "state": self.state,
            "filename": self.filename,
            "received": self.received,
            "total": self.total,
            "error": self.error,
        }

    def cancel(self):
        self._cancel.set()

    def run(self, on_progress=None):
        part = self.path + ".part"
        try:
            if os.path.exists(self.path):
                raise DownloadError(f"{self.filename} is already there.")
            os.makedirs(self.directory, exist_ok=True)
            self.state = "downloading"
            request = urllib.request.Request(
                with_civitai_token(self.url, self.token),
                headers={"User-Agent": "aiembodied-model-downloader/1"},
            )
            digest = hashlib.sha256()
            last = 0.0
            with self.opener(request, timeout=60) as response:
                length = response.headers.get("Content-Length")
                self.total = int(length) if length and length.isdigit() else None
                content_type = (response.headers.get("Content-Type") or "").lower()
                if "text/html" in content_type:
                    # Civitai answers a login page, not a file, when a model needs a key.
                    raise DownloadError("The server sent a web page instead of the file. It may need a Civitai API key.")
                with open(part, "wb") as out:
                    while True:
                        if self._cancel.is_set():
                            raise DownloadError("Cancelled.")
                        chunk = response.read(CHUNK)
                        if not chunk:
                            break
                        out.write(chunk)
                        digest.update(chunk)
                        self.received += len(chunk)
                        now = time.time()
                        if on_progress and now - last > 1:
                            last = now
                            on_progress(self.status())
            if self.total is not None and self.received != self.total:
                raise DownloadError(f"The download stopped early ({self.received} of {self.total} bytes).")
            if self.sha256:
                self.state = "verifying"
                if digest.hexdigest() != self.sha256:
                    raise DownloadError("The file's SHA-256 doesn't match what Civitai lists.")
            os.replace(part, self.path)
            self.state = "done"
        except Exception as error:  # reported to the app, never raised into ComfyUI
            self.state = "cancelled" if self._cancel.is_set() else "failed"
            self.error = str(error) if isinstance(error, DownloadError) else f"{type(error).__name__}: {error}"
            try:
                os.remove(part)
            except OSError:
                pass
        if on_progress:
            on_progress(self.status())
        return self.status()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-dir", required=True)
    parser.add_argument("--model-paths")
    parser.add_argument("--folder", required=True)
    parser.add_argument("--filename", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--sha256")
    args = parser.parse_args(argv)
    try:
        sys.path.insert(0, os.path.abspath(args.comfy_dir))
        import folder_paths
        if args.model_paths:
            from utils.extra_config import load_extra_path_config
            load_extra_path_config(args.model_paths)
        directory = target_folder(args.folder, folder_paths)
        job = Download(args.url, directory, args.filename, args.sha256, os.environ.get("CIVITAI_TOKEN"))
    except Exception as error:
        print(json.dumps({"state": "failed", "error": str(error)}), flush=True)
        return 1
    result = job.run(lambda status: print(json.dumps(status), flush=True))
    return 0 if result["state"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
