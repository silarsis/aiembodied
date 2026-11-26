import pytest
from aiembodied_workflows.interpreter import FlowError, evaluate, parse_choice, run_steps, substitute, truthy


class FakeRunner:
    def __init__(self, thoughts=None, asks=None):
        self.calls: list[tuple] = []
        self.thoughts = list(thoughts or [])
        self.asks = list(asks or [])
        self.steps: list[tuple] = []

    async def think(self, prompt, tools):
        self.calls.append(("think", prompt, tools))
        return self.thoughts.pop(0) if self.thoughts else "ok"

    async def recall(self, query):
        self.calls.append(("recall", query))
        return f"memory of {query}"

    async def remember(self, text):
        self.calls.append(("remember", text))

    async def search(self, query):
        self.calls.append(("search", query))
        return "sunny, 31C"

    async def tool(self, name, params):
        self.calls.append(("tool", name, params))
        return '{"ok": true}'

    async def say(self, text, urgent):
        self.calls.append(("say", text, urgent))

    async def ask(self, question):
        self.calls.append(("ask", question))
        return self.asks.pop(0) if self.asks else True

    async def wait_seconds(self, seconds):
        self.calls.append(("wait_seconds", seconds))

    async def wait_until(self, until):
        self.calls.append(("wait_until", until))

    async def wait_for_entity(self, entity_id, state, timeout):
        self.calls.append(("wait_for_entity", entity_id, state, timeout))
        return True

    async def wait_for_signal(self, name, timeout):
        self.calls.append(("wait_for_signal", name, timeout))
        return False

    async def run_flow(self, name, inputs):
        self.calls.append(("run_flow", name, inputs))
        return "child done"

    async def set_intention(self, text, kind):
        self.calls.append(("set_intention", text, kind))

    async def step_done(self, label, kind, result):
        self.steps.append((label, kind, result))


async def test_variables_and_substitution():
    r = FakeRunner(thoughts=["A short summary"])
    steps = [
        {"search": "weather in {{city}}", "as": "w"},
        {"think": "Summarise {{w}} for {{missing}}!", "as": "s", "tools": True},
        {"say": "{{s}} / {{city}}", "urgent": True},
    ]
    res = await run_steps(steps, {"city": "Singapore"}, r)
    assert r.calls == [
        ("search", "weather in Singapore"),
        ("think", "Summarise sunny, 31C for !", True),
        ("say", "A short summary / Singapore", True),
    ]
    assert res.vars["s"] == "A short summary" and res.executed == 3
    assert [s[0] for s in r.steps] == ["1/3", "2/3", "3/3"]
    assert r.steps[1] == ("2/3", "think", "15 chars")


async def test_substitute_nested():
    assert substitute({"a": ["{{x}}", 3], "b": {"c": "{{ x }}-{{y}}"}}, {"x": "1"}) == {"a": ["1", 3], "b": {"c": "1-"}}


async def test_tool_params_substituted_and_result_kept():
    r = FakeRunner()
    res = await run_steps([{"tool": "lights", "params": {"room": "{{room}}"}, "as": "t"}], {"room": "lounge"}, r)
    assert r.calls == [("tool", "lights", {"room": "lounge"})] and res.vars["t"] == '{"ok": true}'


async def test_if_then_else():
    steps = [{"if": {"var": "n", "op": "gt", "value": 5}, "then": [{"say": "big"}], "else": [{"say": "small"}]}]
    r = FakeRunner()
    await run_steps(steps, {"n": "10"}, r)
    assert r.calls == [("say", "big", False)]
    r = FakeRunner()
    await run_steps(steps, {"n": "2"}, r)
    assert r.calls == [("say", "small", False)]
    r = FakeRunner()
    await run_steps([{"if": {"var": "n", "op": "eq", "value": 1}, "then": [{"say": "x"}]}], {"n": "2"}, r)
    assert r.calls == []


@pytest.mark.parametrize(
    "op,left,value,expected",
    [
        ("eq", "Yes", "yes", True),
        ("eq", "1.0", 1, True),
        ("ne", "a", "b", True),
        ("ne", "a", "A", False),
        ("contains", "Hello World", "world", True),
        ("contains", "abc", "z", False),
        ("gt", "10", 9, True),
        ("gt", "9", "10", False),
        ("lt", "2", 3, True),
        ("lt", "b", "a", False),
        ("gt", "b", "a", True),
    ],
)
def test_evaluate(op, left, value, expected):
    assert evaluate({"var": "x", "op": op, "value": value}, {"x": left}) is expected


def test_truthy_falsy():
    for v in ("", "0", "false", "No", "none", "off"):
        assert not truthy(v)
    for v in ("1", "yes", "something"):
        assert truthy(v)
    assert evaluate({"var": "x", "op": "falsy"}, {}) is True
    assert evaluate({"var": "x", "op": "truthy"}, {"x": "yes"}) is True


async def test_repeat_times_and_round_variable():
    r = FakeRunner()
    await run_steps([{"repeat": {"times": 3}, "steps": [{"say": "round {{round}}"}]}], {}, r)
    assert [c[1] for c in r.calls] == ["round 1", "round 2", "round 3"]


async def test_repeat_until():
    r = FakeRunner(asks=[False, False, True])
    steps = [
        {
            "repeat": {"until": {"var": "done", "op": "eq", "value": "yes"}},
            "steps": [{"ask": "finished?", "as": "done"}],
        }
    ]
    res = await run_steps(steps, {}, r)
    assert len([c for c in r.calls if c[0] == "ask"]) == 3 and res.vars["done"] == "yes"


async def test_repeat_hard_max_rounds_stops_endless_until():
    r = FakeRunner()
    steps = [{"repeat": {"until": {"var": "never", "op": "truthy"}}, "steps": [{"remember": "x"}]}]
    res = await run_steps(steps, {}, r, max_steps=10**6)
    assert len(r.calls) == 1000 and res.vars["round"] == "1000"
    assert any(s[2].startswith("stopped after 1000") for s in r.steps)


async def test_step_cap():
    r = FakeRunner()
    steps = [{"repeat": {"times": 1000}, "steps": [{"say": "a"}, {"say": "b"}]}]
    with pytest.raises(FlowError, match="1000 executed steps"):
        await run_steps(steps, {}, r)
    assert len(r.calls) == 999  # the repeat itself counts as one step


async def test_choose_parses_the_answer():
    for answer, expected in (
        ("no", "no"),
        ("  Yes. ", "yes"),
        ("I would say NO because", "no"),
        ("???", "yes"),
        ("", "yes"),
    ):
        r = FakeRunner(thoughts=[answer])
        res = await run_steps([{"choose": "Umbrella?", "options": ["yes", "no"], "as": "c"}], {}, r)
        assert res.vars["c"] == expected, answer
        assert "Choose exactly one of: yes, no" in r.calls[0][1] and r.calls[0][2] is False


def test_parse_choice_prefers_earliest_mention():
    assert parse_choice("maybe tea, not coffee", ["coffee", "tea"]) == "tea"


async def test_waits_and_signals_and_results():
    r = FakeRunner()
    steps = [
        {"wait": {"seconds": 30}},
        {"wait": {"until": "07:30"}},
        {"wait_for": {"entityId": "a.b", "state": "on"}, "timeoutSeconds": 99, "as": "e"},
        {"wait_for": {"signal": "go"}, "as": "g"},
        {"run_flow": "child", "inputs": {"k": "{{e}}"}, "as": "c"},
        {"set_intention": "water plants", "kind": "goal"},
        {"recall": "plants", "as": "m"},
        {"remember": "I watered {{m}}"},
        {"ask": "ok?", "as": "a"},
    ]
    res = await run_steps(steps, {}, r)
    assert r.calls[:2] == [("wait_seconds", 30.0), ("wait_until", "07:30")]
    assert ("wait_for_entity", "a.b", "on", 99.0) in r.calls and ("wait_for_signal", "go", 3600.0) in r.calls
    assert res.vars["e"] == "ok" and res.vars["g"] == "timeout"
    assert ("run_flow", "child", {"k": "ok"}) in r.calls and ("set_intention", "water plants", "goal") in r.calls
    assert ("remember", "I watered memory of plants") in r.calls and res.vars["a"] == "yes"


async def test_runner_error_propagates():
    class Boom(FakeRunner):
        async def say(self, text, urgent):
            raise FlowError("say broke")

    with pytest.raises(FlowError, match="say broke"):
        await run_steps([{"say": "x"}], {}, Boom())


async def test_non_text_inputs_become_text():
    r = FakeRunner()
    res = await run_steps([{"say": "{{n}} {{o}}"}], {"n": 3, "o": {"a": 1}}, r)
    assert r.calls[0][1] == '3 {"a": 1}' and res.executed == 1
