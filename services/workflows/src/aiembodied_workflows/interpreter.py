"""The flow interpreter (Contract 5).

A plain async function over a small `Runner` protocol. It has no clock, no I/O and no randomness of its own,
so it is deterministic when the runner is, and it can be tested with a fake runner. The AgentFlow workflow
supplies a runner built from activities, timers and signals.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from .flowdef import MAX_ROUNDS, STEP_KEYS, count_steps

MAX_EXECUTED_STEPS = 1000
_VAR = re.compile(r"\{\{\s*([A-Za-z0-9_-]+)\s*\}\}")
_FALSY = {"", "0", "false", "no", "off", "none", "null", "nil"}


class FlowError(Exception):
    """The flow cannot go on (step cap reached, bad runtime value)."""


class Runner(Protocol):
    async def think(self, prompt: str, tools: bool) -> str: ...
    async def recall(self, query: str) -> str: ...
    async def remember(self, text: str) -> None: ...
    async def search(self, query: str) -> str: ...
    async def tool(self, name: str, params: dict[str, Any]) -> str: ...
    async def say(self, text: str, urgent: bool) -> None: ...
    async def ask(self, question: str) -> bool: ...
    async def wait_seconds(self, seconds: float) -> None: ...
    async def wait_until(self, until: str) -> None: ...
    async def wait_for_entity(self, entity_id: str, state: str, timeout: float) -> bool: ...
    async def wait_for_signal(self, name: str, timeout: float) -> bool: ...
    async def run_flow(self, name: str, inputs: dict[str, Any]) -> str: ...
    async def set_intention(self, text: str, kind: str) -> None: ...
    async def step_done(self, label: str, kind: str, result: str) -> None: ...


@dataclass
class FlowResult:
    vars: dict[str, str]
    executed: int
    last: str = ""
    rounds: dict[str, int] = field(default_factory=dict)


def substitute(value: Any, variables: dict[str, str]) -> Any:
    """Replace {{name}} in every string inside value. Unknown names become empty text."""
    if isinstance(value, str):
        return _VAR.sub(lambda m: str(variables.get(m.group(1), "")), value)
    if isinstance(value, list):
        return [substitute(v, variables) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, variables) for k, v in value.items()}
    return value


def _num(text: Any) -> float | None:
    try:
        return float(str(text).strip())
    except ValueError:
        return None


def truthy(text: Any) -> bool:
    return str(text if text is not None else "").strip().lower() not in _FALSY


def evaluate(cond: dict[str, Any], variables: dict[str, str]) -> bool:
    """A flow condition `{"var", "op", "value"}`. Numbers compare as numbers when both sides are numbers."""
    left = variables.get(cond["var"], "")
    op = cond["op"]
    if op == "truthy":
        return truthy(left)
    if op == "falsy":
        return not truthy(left)
    right = substitute(cond.get("value", ""), variables)
    ln, rn = _num(left), _num(right)
    if op in ("eq", "ne"):
        same = ln == rn if ln is not None and rn is not None else str(left).strip().lower() == str(right).strip().lower()
        return same if op == "eq" else not same
    if op == "contains":
        return str(right).strip().lower() in str(left).lower()
    if ln is not None and rn is not None:
        return ln > rn if op == "gt" else ln < rn
    return str(left) > str(right) if op == "gt" else str(left) < str(right)


def parse_choice(text: str, options: list[str]) -> str:
    """The option the answer names. The first option when none is found (or the answer is empty)."""
    low = (text or "").strip().lower()
    for o in options:
        if low.strip(" .\"'`*!") == o.strip().lower():
            return o
    hits = sorted(((low.find(o.strip().lower()), o) for o in options if o.strip().lower() in low), key=lambda t: t[0])
    return hits[0][1] if hits else options[0]


def choose_prompt(question: str, options: list[str]) -> str:
    return f"{question}\nChoose exactly one of: {', '.join(options)}.\nReply with only that option, nothing else."


def _clip(text: str, n: int = 60) -> str:
    t = " ".join(text.split())
    return t if len(t) <= n else t[: n - 1] + "…"


class _Run:
    def __init__(self, runner: Runner, variables: dict[str, str], max_steps: int, total: int):
        self.r = runner
        self.vars = variables
        self.max = max_steps
        self.executed = 0
        self.last = ""
        self.total = total

    async def block(self, steps: list[dict], prefix: str) -> None:
        for i, step in enumerate(steps, 1):
            label = f"{prefix}{i}"
            self.executed += 1
            if self.executed > self.max:
                raise FlowError(f"stopped after {self.max} executed steps")
            kind = _kind_of(step)
            result = await self.one(kind, step, label)
            if kind not in ("if", "repeat"):
                self.last = result
                await self.r.step_done(f"{label}/{self.total}", kind, _describe(kind, result))
            if "as" in step:
                self.vars[step["as"]] = result

    async def one(self, kind: str, step: dict, label: str) -> str:
        r, v = self.r, self.vars
        s = substitute(step[kind], v) if kind not in ("if", "repeat", "wait", "wait_for") else step[kind]
        if kind == "think":
            return await r.think(s, bool(step.get("tools", False)))
        if kind == "choose":
            options = [str(o) for o in substitute(step["options"], v)]
            return parse_choice(await r.think(choose_prompt(s, options), False), options)
        if kind == "recall":
            return await r.recall(s)
        if kind == "remember":
            await r.remember(s)
            return s
        if kind == "search":
            return await r.search(s)
        if kind == "tool":
            params = substitute(step.get("params", {}), v)
            return await r.tool(s, params)
        if kind == "say":
            await r.say(s, bool(step.get("urgent", False)))
            return s
        if kind == "ask":
            return "yes" if await r.ask(s) else "no"
        if kind == "wait":
            spec = substitute(s, v)
            if "seconds" in spec:
                await r.wait_seconds(float(spec["seconds"]))
            else:
                await r.wait_until(str(spec["until"]))
            return ""
        if kind == "wait_for":
            spec = substitute(s, v)
            timeout = float(step.get("timeoutSeconds", 3600))
            if "signal" in spec:
                ok = await r.wait_for_signal(str(spec["signal"]), timeout)
            else:
                ok = await r.wait_for_entity(str(spec["entityId"]), str(spec["state"]), timeout)
            return "ok" if ok else "timeout"
        if kind == "run_flow":
            return await r.run_flow(s, substitute(step.get("inputs", {}), v))
        if kind == "set_intention":
            await r.set_intention(s, step.get("kind", "intention"))
            return s
        if kind == "if":
            taken = evaluate(step["if"], v)
            branch = step.get("then", []) if taken else step.get("else", [])
            await r.step_done(f"{label}/{self.total}", "if", "then" if taken else "else")
            await self.block(branch, f"{label}.")
            return ""
        if kind == "repeat":
            spec = step["repeat"]
            rounds = 0
            while True:
                if "times" in spec:
                    if rounds >= min(int(spec["times"]), MAX_ROUNDS):
                        break
                else:
                    if rounds >= MAX_ROUNDS:
                        await r.step_done(f"{label}/{self.total}", "repeat", f"stopped after {MAX_ROUNDS} rounds")
                        break
                    if evaluate(spec["until"], v):
                        break
                rounds += 1
                self.vars["round"] = str(rounds)
                await self.block(step.get("steps", []), f"{label}.")
            await r.step_done(f"{label}/{self.total}", "repeat", f"{rounds} rounds")
            return str(rounds)
        raise FlowError(f"unknown step {kind}")


def _kind_of(step: dict) -> str:
    for k in step:
        if k in STEP_KEYS:
            return k
    raise FlowError(f"step has no known key: {sorted(step)}")


def _describe(kind: str, result: str) -> str:
    if kind in ("think", "choose", "recall", "search", "tool"):
        return f"{len(result)} chars" if kind != "choose" else result
    if kind in ("say", "remember", "set_intention"):
        return f'"{_clip(result)}"'
    return result or "ok"


async def run_steps(steps: list[dict], inputs: dict[str, Any], runner: Runner, *,
                    max_steps: int = MAX_EXECUTED_STEPS) -> FlowResult:
    """Run a flow's steps. `inputs` become variables. Raises FlowError when the step cap is passed."""
    variables = {k: v if isinstance(v, str) else json.dumps(v) if isinstance(v, (dict, list)) else str(v)
                 for k, v in inputs.items()}
    run = _Run(runner, variables, max_steps, count_steps(steps))
    await run.block(steps, "")
    return FlowResult(vars=run.vars, executed=run.executed, last=run.last)
