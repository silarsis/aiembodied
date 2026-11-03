"""The language model the engine uses for background work (summaries, fact extraction): any
OpenAI-compatible chat endpoint, such as llama-server running Qwen. Uses only the standard
library, so it adds no dependency."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Optional, Protocol


class Llm(Protocol):
    name: str

    def complete_json(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]: ...


class LlmError(RuntimeError):
    pass


def parse_json_object(text: str) -> dict[str, Any]:
    """The first JSON object in a reply, ignoring code fences or chatter around it."""
    text = text.strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise LlmError("the model did not answer with JSON") from None
        try:
            value = json.loads(match.group(0))
        except json.JSONDecodeError as error:
            raise LlmError(f"the model's JSON did not parse: {error}") from None
    if not isinstance(value, dict):
        raise LlmError("the model's JSON was not an object")
    return value


class OpenAICompatibleLlm:
    def __init__(self, base_url: str, model: str, api_key: Optional[str] = None, timeout: float = 300.0):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.name = model
        self.api_key = api_key
        self.timeout = timeout

    def complete_json(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0.2,
            "stream": False,
            "response_format": {"type": "json_schema", "json_schema": {"name": "result", "schema": schema}},
        }
        if "api.openai.com" not in self.base_url:
            # llama-server running Qwen: answer straight away, without a thinking pass.
            body["chat_template_kwargs"] = {"enable_thinking": False}
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions", data=json.dumps(body).encode(), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310 - configured URL
                payload = json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise LlmError(f"{self.base_url} answered {error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise LlmError(f"{self.base_url} unreachable: {error}") from None
        try:
            content = payload["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise LlmError("unexpected reply shape from the model") from None
        return parse_json_object(content)


def make_llm(url: Optional[str], model: str, api_key: Optional[str] = None) -> Optional[Llm]:
    if not url or url.strip().lower() in ("off", "none", "0"):
        return None
    return OpenAICompatibleLlm(url, model, api_key)
