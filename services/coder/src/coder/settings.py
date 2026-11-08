"""Settings the app can change at run time (settings.json in the data directory)."""

from __future__ import annotations

import json
import logging
from typing import Literal, Optional

from pydantic import BaseModel, Field

from .agentdir import write_agent_dir
from .config import Config

log = logging.getLogger("coder")


class DefaultModel(BaseModel):
    provider: Literal["openai", "anthropic", "local"]
    id: str = Field(min_length=1)


class SettingsBody(BaseModel):
    local_llm_url: Optional[str] = Field(default=None, min_length=1)
    local_model: Optional[str] = Field(default=None, min_length=1)
    default_model: Optional[DefaultModel] = None


def snapshot(cfg: Config) -> dict:
    return {"local_llm_url": cfg.local_llm_url, "local_model": cfg.local_model, "default_model": cfg.default_model}


def apply(cfg: Config, body: SettingsBody) -> dict:
    """Apply the given fields to cfg, save them and rewrite the pi agent dir."""
    if body.local_llm_url:
        cfg.local_llm_url = body.local_llm_url.rstrip("/")
    if body.local_model:
        cfg.local_model = body.local_model
    if body.default_model:
        cfg.default_provider, cfg.default_model_id = body.default_model.provider, body.default_model.id
    cfg.settings_path.write_text(json.dumps({
        "local_llm_url": cfg.local_llm_url, "local_model": cfg.local_model,
        "default_provider": cfg.default_provider, "default_model_id": cfg.default_model_id,
    }, indent=2), encoding="utf-8")
    write_agent_dir(cfg)
    return snapshot(cfg)


def load(cfg: Config) -> None:
    """Let a saved settings.json override the environment defaults."""
    try:
        data = json.loads(cfg.settings_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(data, dict):
        return
    for key in ("local_llm_url", "local_model", "default_provider", "default_model_id"):
        if isinstance(data.get(key), str):
            setattr(cfg, key, data[key])
