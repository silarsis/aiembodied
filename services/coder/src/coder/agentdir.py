"""The pi config directory the runner owns (PI_CODING_AGENT_DIR). Rewritten on every start."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from .config import Config

GUARD_NAME = "aiembodied-guard.ts"


def guard_source() -> Path:
    return Path(__file__).parent / "assets" / GUARD_NAME


def write_agent_dir(cfg: Config) -> Path:
    d = cfg.agent_dir
    (d / "extensions").mkdir(parents=True, exist_ok=True)
    models = {
        "providers": {
            "local": {
                "baseUrl": cfg.local_llm_url,
                "api": "openai-completions",
                "apiKey": "not-needed",
                "models": [{"id": cfg.local_model, "contextWindow": cfg.local_context}],
            }
        }
    }
    settings = {"defaultProvider": "local", "defaultModel": cfg.local_model, "packages": []}
    (d / "models.json").write_text(json.dumps(models, indent=2), encoding="utf-8")
    (d / "settings.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")
    shutil.copyfile(guard_source(), d / "extensions" / GUARD_NAME)
    return d
