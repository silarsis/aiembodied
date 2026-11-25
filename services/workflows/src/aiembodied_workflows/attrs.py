"""Search attributes: AgentId, Owner, Purpose and Flow (keyword attributes the Temporal start script registers)."""

from __future__ import annotations

from temporalio.common import SearchAttributeKey, SearchAttributePair, TypedSearchAttributes

AGENT_ID = SearchAttributeKey.for_keyword("AgentId")
OWNER = SearchAttributeKey.for_keyword("Owner")
PURPOSE = SearchAttributeKey.for_keyword("Purpose")
FLOW = SearchAttributeKey.for_keyword("Flow")


def search_attrs(avatar_id: str, purpose: str, owner: str = "agent", flow: str | None = None) -> TypedSearchAttributes:
    """Owner is "agent" (the avatar made it), "kevin" or "system"."""
    pairs = [SearchAttributePair(AGENT_ID, avatar_id), SearchAttributePair(OWNER, owner),
             SearchAttributePair(PURPOSE, purpose)]
    if flow:
        pairs.append(SearchAttributePair(FLOW, flow))
    return TypedSearchAttributes(pairs)


def purpose_of(workflow_id: str) -> str:
    """The purpose that goes with a workflow id prefix."""
    prefix = workflow_id.split(":", 1)[0]
    return {"life": "life", "remind": "reminder", "wake": "wakeup", "watch": "watch", "flowwatch": "watch",
            "flow": "flow", "sched": "flow"}.get(prefix, prefix)


def attr_value(search_attributes, key: SearchAttributeKey) -> str | None:
    try:
        return search_attributes.get(key)
    except Exception:  # noqa: BLE001
        return None
