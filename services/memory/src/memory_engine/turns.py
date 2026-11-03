"""Group a session's messages into turns, the unit retrieval works on.

A turn is a user message and everything after it up to the next user message: tool calls with
their results and the reply. A question means little without its answer, so they are indexed
together. Messages before a session's first user message (a greeting) form a turn of their own.
Turns are worked out from time order rather than stored, so a message that arrives late (the
app's writes are queued and can be retried) still lands in the right turn when the session's
turns are rebuilt.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional, Sequence
from uuid import UUID

# Tool results can be whole web pages; the turn keeps the start, the message keeps it all.
TOOL_RESULT_CHARS = 600
TURN_TEXT_CHARS = 6000


@dataclass(frozen=True)
class Message:
    id: UUID
    role: str
    content: str
    created_at: datetime
    seq: int = 0
    speaker: Optional[str] = None
    tool: Optional[dict[str, Any]] = None
    private: bool = False


@dataclass
class Turn:
    source_id: UUID
    period_start: datetime
    period_end: datetime
    messages: list[Message] = field(default_factory=list)

    @property
    def message_ids(self) -> list[UUID]:
        return [message.id for message in self.messages]

    @property
    def private(self) -> bool:
        return any(message.private for message in self.messages)

    def text(self, agent_label: str = "Assistant") -> str:
        lines = [render_message(message, agent_label) for message in self.messages]
        text = "\n".join(line for line in lines if line)
        return text if len(text) <= TURN_TEXT_CHARS else text[:TURN_TEXT_CHARS] + "…"


def render_message(message: Message, agent_label: str = "Assistant") -> str:
    content = message.content.strip()
    if message.role == "tool":
        tool = message.tool or {}
        name = tool.get("name") or "tool"
        arguments = tool.get("arguments")
        call = f"{name}({_short(arguments, 200)})" if arguments not in (None, "", {}) else name
        status = "" if tool.get("ok", True) else " failed"
        return f"[{call}{status}] {_short(content, TOOL_RESULT_CHARS)}".rstrip()
    if message.role == "user":
        return f"{message.speaker or 'User'}: {content}"
    if message.role == "assistant":
        return f"{agent_label}: {content}"
    return ""  # system messages are kept in the record but not indexed


def _short(value: Any, limit: int) -> str:
    text = value if isinstance(value, str) else ("" if value is None else str(value))
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "…"


def assemble_turns(messages: Sequence[Message]) -> list[Turn]:
    ordered = sorted(messages, key=lambda m: (m.created_at, m.seq))
    turns: list[Turn] = []
    for message in ordered:
        if message.role == "system":
            continue
        if message.role == "user" or not turns:
            turns.append(Turn(message.id, message.created_at, message.created_at, [message]))
        else:
            turns[-1].messages.append(message)
            turns[-1].period_end = message.created_at
    return turns
