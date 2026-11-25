"""The workflow classes are valid Temporal definitions and load in the sandbox (no server needed)."""

import pytest
from temporalio.workflow import _Definition

from aiembodied_workflows.registry import WORKFLOWS, sandbox_runner

EXPECTED = {
    "AgentLife": {"interaction", "spoke", "sleep", "wake", "pause", "resume"},
    "Reminder": {"pause", "resume", "snooze", "note"},
    "WakeMe": {"pause", "resume", "snooze", "note"},
    "Watch": {"home_change", "task_status", "pause", "resume", "snooze", "note"},
    "AgentFlow": {"home_change", "pause", "resume", "snooze", "note"},
}


@pytest.mark.parametrize("cls", WORKFLOWS, ids=lambda c: c.__name__)
async def test_definition_and_sandbox(cls):
    d = _Definition.must_from_class(cls)
    assert set(d.signals) - {None} == EXPECTED[d.name]  # None is the dynamic handler
    sandbox_runner().prepare_workflow(d)


def test_every_activity_is_a_valid_definition():
    import temporalio.activity as ta

    from aiembodied_workflows.activities import Activities
    from aiembodied_workflows.settings import Settings

    names = [ta._Definition.must_from_callable(a).name for a in Activities(Settings()).all()]
    assert len(names) == len(set(names)) and "app_act" in names and "journal" in names
    # every activity the workflows call by name exists
    import pathlib
    import re

    src = "".join(p.read_text() for p in pathlib.Path(__file__).parents[1].glob("src/aiembodied_workflows/wf/*.py"))
    called = set(re.findall(r'(?:best_effort|execute_activity|execute_local_activity)\(\s*"([a-z_]+)"', src))
    assert called <= set(names), called - set(names)
