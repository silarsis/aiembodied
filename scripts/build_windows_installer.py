#!/usr/bin/env python3
"""Build the packaged desktop app (the Electron app only) as a Windows installer and a portable exe.

The workspace uses pnpm's symlinked node_modules, which electron-builder does not package well. So this
script stages a plain, self-contained copy of the app first and packages that:

    <stage>/package.json            name, version, main = app/main/dist/main.js
    <stage>/app/main/dist           the built main process
    <stage>/app/main/assets         wake word models, rooms, backgrounds, default avatar
    <stage>/app/main/node_modules   production dependencies, flat (pnpm deploy, hoisted)
    <stage>/app/renderer/dist       the built renderer

The Python services (memory engine, speech, motion, laya, ...), llama-server and every model are NOT in
the package. See docs/windows-installer.md for what the installed app can do without them.

Usage (from the repo root, after `pnpm install --frozen-lockfile`):

    python scripts/build_windows_installer.py                 # Windows: NSIS installer + portable exe
    python scripts/build_windows_installer.py --version 0.1.0
    python scripts/build_windows_installer.py --target dir    # unpacked folder only (quick check)
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MAIN = REPO / "app" / "main"
RENDERER = REPO / "app" / "renderer"
CONFIG = REPO / "packaging" / "windows" / "electron-builder.yml"

# Kept out of the staged app's own dependency list: electron-builder supplies Electron itself.
BUILD_ONLY_DEPENDENCIES = {"electron"}


def run(*args: str, cwd: Path = REPO) -> None:
    print(f"$ {' '.join(args)}", flush=True)
    # shell=True on Windows so pnpm.cmd / npx.cmd resolve.
    subprocess.run(list(args), cwd=cwd, check=True, shell=os.name == "nt")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def default_version() -> str:
    release = REPO / "RELEASE.txt"
    if release.exists():
        text = release.read_text(encoding="utf-8").strip()
        if text:
            return text
    return read_json(REPO / "package.json")["version"]


def electron_version() -> str:
    """The Electron version the workspace installed for app/main (from the lockfile, via node_modules)."""
    manifest = MAIN / "node_modules" / "electron" / "package.json"
    if not manifest.exists():
        sys.exit("app/main/node_modules/electron is missing: run `pnpm install --frozen-lockfile` first.")
    return read_json(manifest)["version"]


def stage_app(stage: Path, version: str) -> None:
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    # Production dependencies of app/main, at the lockfile's versions, as a flat node_modules that
    # electron-builder can copy. The workspace's onlyBuiltDependencies still apply (keytar fetches its
    # prebuilt binary; better-sqlite3 and onnxruntime-node use the prebuilds they ship).
    main_stage = stage / "app" / "main"
    run(
        "pnpm", "--filter", "@aiembodied/main", "deploy", "--prod", "--legacy",
        "--config.node-linker=hoisted", str(main_stage),
    )

    # pnpm deploy copies the whole package folder; the package only needs dist and assets. Replace dist
    # and assets with the fresh build in case deploy used a stale copy.
    for name in ("dist", "assets"):
        target = main_stage / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(MAIN / name, target)

    main_pkg = read_json(main_stage / "package.json")
    for dep in BUILD_ONLY_DEPENDENCIES:
        main_pkg.get("dependencies", {}).pop(dep, None)
    main_pkg["version"] = version
    write_json(main_stage / "package.json", main_pkg)
    for dep in BUILD_ONLY_DEPENDENCIES:
        shutil.rmtree(main_stage / "node_modules" / dep, ignore_errors=True)
    # Command shims are not needed at run time, and some now point at removed packages.
    shutil.rmtree(main_stage / "node_modules" / ".bin", ignore_errors=True)

    renderer_stage = stage / "app" / "renderer"
    renderer_stage.mkdir(parents=True)
    shutil.copytree(RENDERER / "dist", renderer_stage / "dist")

    write_json(
        stage / "package.json",
        {
            "name": "aiembodied",
            "productName": "AI Embodied Assistant",
            "version": version,
            "description": "AI Embodied Assistant: an embodied voice companion",
            "author": "silarsis",
            "license": "MIT",
            "private": True,
            "main": "app/main/dist/main.js",
            "type": "module",
            # electron-builder reads the Electron version from here.
            "devDependencies": {"electron": electron_version()},
        },
    )

    # electron-builder looks for installer resources (installer.nsh) in <projectDir>/build.
    resources = stage / "build"
    resources.mkdir()
    shutil.copy2(CONFIG.parent / "installer.nsh", resources / "installer.nsh")


def package(stage: Path, out: Path, target: str) -> None:
    if out.exists():
        shutil.rmtree(out)
    host = platform.system()
    if target == "dir":
        platform_flag = {"Windows": "--win", "Darwin": "--mac"}.get(host, "--linux")
        targets = ["dir"]
    else:
        if host != "Windows":
            sys.exit("Building the Windows installer needs Windows (use --target dir for a local check).")
        platform_flag = "--win"
        targets = ["nsis", "portable"]
    run(
        "pnpm", "exec", "electron-builder",
        "--config", str(CONFIG),
        "--projectDir", str(stage),
        platform_flag, *targets,
        "--x64",
        "--publish", "never",
        f"-c.directories.output={out}",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", default=None, help="App version (default: RELEASE.txt)")
    parser.add_argument("--stage", type=Path, default=REPO / "build" / "windows-stage")
    parser.add_argument("--out", type=Path, default=REPO / "release")
    parser.add_argument("--target", choices=["installer", "dir"], default="installer")
    parser.add_argument("--skip-build", action="store_true", help="Use the existing app/main and app/renderer builds")
    args = parser.parse_args()

    version = args.version or default_version()
    print(f"Building AI Embodied Assistant {version}", flush=True)
    if not args.skip_build:
        run("pnpm", "build")
    stage_app(args.stage.resolve(), version)
    package(args.stage.resolve(), args.out.resolve(), args.target)
    print("Done. Output:", args.out.resolve(), flush=True)


if __name__ == "__main__":
    main()
