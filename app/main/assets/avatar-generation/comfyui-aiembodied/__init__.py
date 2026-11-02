"""aiembodied add-on for ComfyUI: model downloads and model descriptions for the aiembodied app.

Install on a ComfyUI machine by copying this folder into ComfyUI/custom_nodes/ (the folder name
doesn't matter) and restarting ComfyUI. It adds no nodes, only these routes:

  GET    /aiembodied/ping                 -> {"ok": true, "version": 2}
  GET    /aiembodied/models               -> the image/3D model files with their kinds, as the app's
                                             own scan on this PC reports them
  POST   /aiembodied/download             {url, folder, filename, sha256?, civitai_token?, info?}
  GET    /aiembodied/download/{id}        -> {id, state, received, total, error}
  DELETE /aiembodied/download/{id}        -> cancels it

Anyone who can reach this ComfyUI can use them, like ComfyUI itself: keep it on your own network
(or Tailscale). Set AIEMBODIED_DOWNLOADS=0 in ComfyUI's environment to turn downloads off.
"""
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import aiembodied_downloader as downloader  # noqa: E402  (prefixed names avoid clashing with other custom nodes)
import aiembodied_model_kinds as model_kinds  # noqa: E402

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_jobs = {}
_lock = threading.Lock()


def _register():
    try:
        import folder_paths
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return  # imported outside ComfyUI (tests, the app's script)
    routes = PromptServer.instance.routes

    @routes.get("/aiembodied/ping")
    async def ping(_request):
        return web.json_response({"ok": True, "version": 2, "downloads": os.environ.get("AIEMBODIED_DOWNLOADS") != "0"})

    @routes.get("/aiembodied/models")
    async def models(_request):
        return web.json_response(model_kinds.scan(folder_paths))

    @routes.post("/aiembodied/download")
    async def start(request):
        if os.environ.get("AIEMBODIED_DOWNLOADS") == "0":
            return web.json_response({"error": "Downloads are turned off on this ComfyUI (AIEMBODIED_DOWNLOADS=0)."}, status=403)
        try:
            body = await request.json()
            directory = downloader.target_folder(str(body.get("folder", "")), folder_paths)
            job = downloader.Download(
                body.get("url", ""), directory, body.get("filename", ""), body.get("sha256"), body.get("civitai_token") or None,
                info=body.get("info"),
            )
        except downloader.DownloadError as error:
            return web.json_response({"error": str(error)}, status=400)
        except ValueError:
            return web.json_response({"error": "Send the download as JSON."}, status=400)
        with _lock:
            for other in _jobs.values():
                if other.path == job.path and other.state in ("queued", "downloading", "verifying"):
                    return web.json_response({"error": f"{job.filename} is already downloading."}, status=409)
            _jobs[job.id] = job
        threading.Thread(target=job.run, name=f"aiembodied-download-{job.id[:8]}", daemon=True).start()
        return web.json_response(job.status())

    @routes.get("/aiembodied/download/{id}")
    async def status(request):
        job = _jobs.get(request.match_info["id"])
        return web.json_response(job.status()) if job else web.json_response({"error": "No such download."}, status=404)

    @routes.delete("/aiembodied/download/{id}")
    async def cancel(request):
        job = _jobs.get(request.match_info["id"])
        if not job:
            return web.json_response({"error": "No such download."}, status=404)
        job.cancel()
        return web.json_response(job.status())


_register()
