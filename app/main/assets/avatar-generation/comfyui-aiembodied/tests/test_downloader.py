"""Run with: python -m unittest discover -s app/main/assets/avatar-generation/comfyui-aiembodied/tests"""
import hashlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import aiembodied_downloader as downloader  # noqa: E402


class FakeResponse(io.BytesIO):
    def __init__(self, body, content_type="application/octet-stream", length=True):
        super().__init__(body)
        self.headers = {"Content-Type": content_type}
        if length:
            self.headers["Content-Length"] = str(len(body))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class DownloaderTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def test_downloads_to_part_then_renames_and_checks_sha(self):
        body = b"x" * 1000
        seen = {}

        def opener(request, timeout):
            seen["url"] = request.full_url
            return FakeResponse(body)

        job = downloader.Download(
            "https://civitai.com/api/download/models/1?type=Model", self.dir, "m.safetensors",
            hashlib.sha256(body).hexdigest().upper(), "secret", opener,
        )
        status = job.run()
        self.assertEqual(status["state"], "done")
        with open(os.path.join(self.dir, "m.safetensors"), "rb") as saved:
            self.assertEqual(saved.read(), body)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "m.safetensors.part")))
        self.assertIn("token=secret", seen["url"])
        self.assertIn("type=Model", seen["url"])

    def test_saves_civitai_details_beside_the_file(self):
        job = downloader.Download(
            "https://civitai.com/x", self.dir, "style.safetensors", None, None, lambda r, timeout: FakeResponse(b"x"),
            info={"name": "Style", "baseModel": "SDXL 1.0", "family": "sdxl", "triggerWords": ["neon"]},
        )
        self.assertEqual(job.run()["state"], "done")
        import json
        with open(os.path.join(self.dir, "style.aiembodied.json")) as stream:
            self.assertEqual(json.load(stream)["triggerWords"], ["neon"])

    def test_bad_hash_short_file_and_login_page_fail_and_leave_nothing(self):
        cases = [
            (lambda r, timeout: FakeResponse(b"abc"), "0" * 64, "SHA-256"),
            (lambda r, timeout: FakeResponse(b"<html>", "text/html; charset=utf-8"), None, "web page"),
        ]
        for opener, sha, message in cases:
            job = downloader.Download("https://example.com/m", self.dir, "m.safetensors", sha, None, opener)
            status = job.run()
            self.assertEqual(status["state"], "failed")
            self.assertIn(message, status["error"])
            self.assertEqual(os.listdir(self.dir), [])

        short = FakeResponse(b"abc")
        short.headers["Content-Length"] = "10"
        job = downloader.Download("https://example.com/m", self.dir, "m.safetensors", None, None, lambda r, timeout: short)
        self.assertIn("stopped early", job.run()["error"])

    def test_refuses_unsafe_names_urls_folders_and_existing_files(self):
        for name in ("../evil.safetensors", "C:\\x\\..\\.hidden.safetensors", "notes.txt", ".."):
            with self.subTest(name=name):
                try:
                    cleaned = downloader.safe_filename(name)
                except downloader.DownloadError:
                    continue
                self.assertNotIn("/", cleaned)
                self.assertNotIn("..", cleaned)
        self.assertEqual(downloader.safe_filename("a/b/model.safetensors"), "model.safetensors")
        with self.assertRaises(downloader.DownloadError):
            downloader.check_url("http://civitai.com/x")
        with self.assertRaises(downloader.DownloadError):
            downloader.target_folder("custom_nodes", folder_paths=object())
        open(os.path.join(self.dir, "m.safetensors"), "wb").close()
        job = downloader.Download("https://example.com/m", self.dir, "m.safetensors", None, None, lambda r, timeout: FakeResponse(b"x"))
        self.assertIn("already there", job.run()["error"])

    def test_token_only_goes_to_civitai(self):
        self.assertEqual(downloader.with_civitai_token("https://huggingface.co/a", "k"), "https://huggingface.co/a")
        self.assertIn("token=k", downloader.with_civitai_token("https://civitai.com/api/download/models/5", "k"))
        self.assertIn("token=k", downloader.with_civitai_token("https://civitai.red/api/download/models/5", "k"))


if __name__ == "__main__":
    unittest.main()
