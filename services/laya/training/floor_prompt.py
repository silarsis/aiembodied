"""Shared prompt builders for the Laya floor-routing classifier.

Used for training rows and mirrored by the app, so keep this simple and stable.
Standard library only.
"""
from __future__ import annotations

from typing import Optional

RECENT_CLIP = 200
MAX_RECENT = 4


def option_key(name: str) -> str:
    return name.lower()


def _clip(text: str, n: int = RECENT_CLIP) -> str:
    return text if len(text) <= n else text[:n]


def build_state(
    scene: list[str],
    host: str,
    last: Optional[str],
    recent: list[tuple[str, str]],
    text: str,
) -> str:
    parts = []
    for name in scene:
        parts.append(f"{name} (host)" if name == host else name)
    lines = [
        f"Avatars in the room: {', '.join(parts)}.",
        f"Kevin last spoke with: {last if last else 'nobody'}.",
    ]
    for speaker, line in recent[-MAX_RECENT:]:
        lines.append(f"{speaker}: {_clip(line)}")
    lines.append(f"Kevin: {text}")
    return "\n".join(lines)


def build_questions(scene: list[str]) -> dict:
    addressed = {option_key(n): f"Kevin is speaking to {n}" for n in scene}
    addressed["everyone"] = "Kevin is speaking to all the avatars"
    addressed["unclear"] = "The line does not say which avatar he is speaking to"
    other = {option_key(n): n for n in scene}
    other["none"] = "no other avatar is involved"
    return {
        "addressed": {
            "type": "choice",
            "instructions": "Which avatar is Kevin speaking to in his last line, the one who should act on it?",
            "criteria": addressed,
        },
        "wants": {
            "type": "choice",
            "instructions": "What does Kevin want that avatar to do?",
            "criteria": {
                "answer": "reply to Kevin or do what he asks",
                "converse": "go and have a conversation with another avatar",
                "relay": "ask or tell another avatar something for Kevin",
            },
        },
        "other": {
            "type": "choice",
            "instructions": "Which other avatar should they talk to or pass the message to?",
            "criteria": other,
        },
    }


def resolve_speaker(
    addressed: str,
    other: str,
    scene: list[str],
    host: str,
    last: Optional[str],
) -> str:
    """Return the lower-case avatar key that should act, or 'everyone'."""
    if addressed != "unclear":
        return addressed
    other_k = option_key(other) if other else other
    if last and option_key(last) != other_k:
        return option_key(last)
    if option_key(host) != other_k:
        return option_key(host)
    for name in scene:
        if option_key(name) != other_k:
            return option_key(name)
    return option_key(host)
