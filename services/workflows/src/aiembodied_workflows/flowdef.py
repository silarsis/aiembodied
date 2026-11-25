"""Agent-built flow definitions (Contract 5): validation. Pure."""

from __future__ import annotations

import re
from typing import Any

from .conditions import validate_condition

MAX_DEPTH = 6
MAX_STEPS = 200
MAX_ROUNDS = 1000
NAME_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
VAR_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
OPS = ("eq", "ne", "contains", "gt", "lt", "truthy", "falsy")

# step key -> modifier keys it may carry (besides "as")
STEP_KEYS: dict[str, tuple[str, ...]] = {
    "think": ("tools",),
    "choose": ("options",),
    "recall": (),
    "remember": (),
    "search": (),
    "tool": ("params",),
    "say": ("urgent",),
    "ask": (),
    "wait": (),
    "wait_for": ("timeoutSeconds",),
    "if": ("then", "else"),
    "repeat": ("steps",),
    "run_flow": ("inputs",),
    "set_intention": ("kind",),
}
INTENTION_KINDS = ("goal", "intention", "promise")


def valid_name(name: Any) -> bool:
    return isinstance(name, str) and NAME_RE.match(name) is not None


def validate_trigger(trigger: Any) -> list[str]:
    errs: list[str] = []
    if not isinstance(trigger, dict):
        return ["trigger: must be an object"]
    kind = trigger.get("kind")
    if kind == "manual":
        pass
    elif kind == "schedule":
        has_cron, has_every = "cron" in trigger, "everyMinutes" in trigger
        if has_cron == has_every:
            errs.append("trigger: a schedule needs exactly one of cron or everyMinutes")
        elif has_cron:
            c = trigger["cron"]
            if not isinstance(c, str) or len(c.split()) != 5:
                errs.append('trigger.cron: must be five fields, like "30 7 * * 1-5"')
        else:
            e = trigger["everyMinutes"]
            if not isinstance(e, (int, float)) or isinstance(e, bool) or e < 1:
                errs.append("trigger.everyMinutes: must be a number, 1 or more")
    elif kind == "watch":
        errs += validate_condition(trigger.get("condition"), "trigger.condition")
    else:
        errs.append("trigger.kind: must be one of manual, schedule, watch")
    return errs


def validate_definition(definition: Any) -> list[str]:
    """Error strings (with paths like `steps[2].wait: ...`); empty when the definition is fine."""
    if not isinstance(definition, dict):
        return ["definition: must be an object with steps"]
    errs: list[str] = []
    inputs = definition.get("inputs", {})
    if not isinstance(inputs, dict):
        errs.append("inputs: must be an object")
    else:
        for k in inputs:
            if not VAR_RE.match(str(k)):
                errs.append(f"inputs.{k}: names use letters, digits, _ and -")
    steps = definition.get("steps")
    if not isinstance(steps, list) or not steps:
        errs.append("steps: must be a list with at least one step")
        return errs
    counter = [0]
    _steps(steps, "steps", 1, counter, errs)
    if counter[0] > MAX_STEPS:
        errs.append(f"steps: {counter[0]} steps in total, the most allowed is {MAX_STEPS}")
    return errs


def count_steps(steps: list) -> int:
    n = 0
    for s in steps:
        if not isinstance(s, dict):
            continue
        n += 1
        for key in ("then", "else", "steps"):
            if isinstance(s.get(key), list):
                n += count_steps(s[key])
    return n


def _steps(steps: Any, path: str, depth: int, counter: list[int], errs: list[str]) -> None:
    if not isinstance(steps, list):
        errs.append(f"{path}: must be a list of steps")
        return
    if depth > MAX_DEPTH:
        errs.append(f"{path}: nested more than {MAX_DEPTH} levels deep")
        return
    for i, step in enumerate(steps):
        here = f"{path}[{i}]"
        counter[0] += 1
        if not isinstance(step, dict):
            errs.append(f"{here}: must be an object")
            continue
        keys = [k for k in step if k in STEP_KEYS]
        if len(keys) != 1:
            errs.append(f"{here}: needs exactly one step key out of {', '.join(STEP_KEYS)} (found {keys or 'none'})")
            continue
        key = keys[0]
        allowed = {key, "as", *STEP_KEYS[key]}
        for extra in step:
            if extra not in allowed:
                errs.append(f"{here}.{extra}: not used by a {key} step")
        if "as" in step and (not isinstance(step["as"], str) or not VAR_RE.match(step["as"])):
            errs.append(f"{here}.as: a variable name of letters, digits, _ and -")
        _step(key, step, f"{here}.{key}", here, depth, counter, errs)


def _text(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _step(key: str, step: dict, p: str, here: str, depth: int, counter: list[int], errs: list[str]) -> None:
    v = step[key]
    if key in ("think", "recall", "remember", "search", "ask", "say", "set_intention"):
        if not _text(v):
            errs.append(f"{p}: must be non-empty text")
        if key == "think" and "tools" in step and not isinstance(step["tools"], bool):
            errs.append(f"{here}.tools: must be true or false")
        if key == "say" and "urgent" in step and not isinstance(step["urgent"], bool):
            errs.append(f"{here}.urgent: must be true or false")
        if key == "set_intention" and step.get("kind", "intention") not in INTENTION_KINDS:
            errs.append(f"{here}.kind: must be one of {', '.join(INTENTION_KINDS)}")
    elif key == "choose":
        if not _text(v):
            errs.append(f"{p}: must be non-empty text")
        opts = step.get("options")
        if not isinstance(opts, list) or len(opts) < 2 or not all(_text(o) for o in opts):
            errs.append(f"{here}.options: needs a list of at least two non-empty texts")
    elif key == "tool":
        if not _text(v):
            errs.append(f"{p}: must be a tool name")
        if "params" in step and not isinstance(step["params"], dict):
            errs.append(f"{here}.params: must be an object")
    elif key == "wait":
        if not isinstance(v, dict) or len(v) != 1 or next(iter(v)) not in ("seconds", "until"):
            errs.append(f'{p}: must be {{"seconds": n}} or {{"until": "HH:MM" or an ISO time}}')
        elif "seconds" in v:
            if not isinstance(v["seconds"], (int, float)) or isinstance(v["seconds"], bool) or v["seconds"] < 0:
                errs.append(f"{p}.seconds: must be a number, 0 or more")
        elif not _text(v["until"]):
            errs.append(f"{p}.until: must be text")
    elif key == "wait_for":
        ok = isinstance(v, dict) and (
            ("signal" in v and len(v) == 1 and _text(v["signal"]))
            or ("entityId" in v and "state" in v and set(v) <= {"entityId", "state"} and _text(v["entityId"]))
        )
        if not ok:
            errs.append(f'{p}: must be {{"entityId": "...", "state": "..."}} or {{"signal": "name"}}')
        t = step.get("timeoutSeconds", 3600)
        if not isinstance(t, (int, float)) or isinstance(t, bool) or t <= 0:
            errs.append(f"{here}.timeoutSeconds: must be a number above 0")
    elif key == "if":
        errs += _cond(v, p)
        if "then" not in step:
            errs.append(f"{here}.then: required list of steps")
        else:
            _steps(step["then"], f"{here}.then", depth + 1, counter, errs)
        if "else" in step:
            _steps(step["else"], f"{here}.else", depth + 1, counter, errs)
    elif key == "repeat":
        ok = isinstance(v, dict) and len(v) == 1 and next(iter(v)) in ("times", "until")
        if not ok:
            errs.append(f'{p}: must be {{"times": n}} or {{"until": {{condition}}}}')
        elif "times" in v:
            t = v["times"]
            if not isinstance(t, int) or isinstance(t, bool) or t < 1 or t > MAX_ROUNDS:
                errs.append(f"{p}.times: must be a whole number from 1 to {MAX_ROUNDS}")
        else:
            errs += _cond(v["until"], f"{p}.until")
        if "steps" not in step:
            errs.append(f"{here}.steps: required list of steps")
        else:
            _steps(step["steps"], f"{here}.steps", depth + 1, counter, errs)
    elif key == "run_flow":
        if not valid_name(v):
            errs.append(f"{p}: a flow name of a-z, 0-9, _ and -, up to 64 characters")
        if "inputs" in step and not isinstance(step["inputs"], dict):
            errs.append(f"{here}.inputs: must be an object")


def _cond(c: Any, p: str) -> list[str]:
    if not isinstance(c, dict):
        return [f'{p}: must be {{"var": "x", "op": "eq", "value": ...}}']
    errs: list[str] = []
    if not isinstance(c.get("var"), str) or not VAR_RE.match(c["var"]):
        errs.append(f"{p}.var: a variable name")
    if c.get("op") not in OPS:
        errs.append(f"{p}.op: must be one of {', '.join(OPS)}")
    elif c["op"] not in ("truthy", "falsy") and "value" not in c:
        errs.append(f"{p}.value: required for {c['op']}")
    return errs


def validate_flow(name: Any, definition: Any, trigger: Any) -> list[str]:
    errs: list[str] = []
    if not valid_name(name):
        errs.append("name: use a-z, 0-9, _ and -, up to 64 characters")
    errs += validate_definition(definition)
    errs += validate_trigger(trigger)
    return errs
