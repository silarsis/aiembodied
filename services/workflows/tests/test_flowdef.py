import copy

import pytest

from aiembodied_workflows import flowdef as f

GOOD = {
    "inputs": {"city": "Singapore"},
    "steps": [
        {"search": "weather in {{city}}", "as": "w"},
        {"think": "Summarise: {{w}}", "tools": False, "as": "s"},
        {"choose": "Umbrella?", "options": ["yes", "no"], "as": "u"},
        {"if": {"var": "u", "op": "eq", "value": "yes"}, "then": [{"say": "Take an umbrella"}],
         "else": [{"say": "No umbrella", "urgent": False}]},
        {"wait": {"seconds": 60}},
        {"wait": {"until": "07:30"}},
        {"wait_for": {"entityId": "binary_sensor.door", "state": "on"}, "timeoutSeconds": 600},
        {"wait_for": {"signal": "go"}},
        {"repeat": {"times": 3}, "steps": [{"recall": "bins"}, {"remember": "took bins out"}]},
        {"repeat": {"until": {"var": "x", "op": "truthy"}}, "steps": [{"ask": "done?", "as": "x"}]},
        {"tool": "lights_on", "params": {"room": "lounge"}},
        {"run_flow": "other-flow", "inputs": {"a": 1}},
        {"set_intention": "water the plants", "kind": "goal"},
    ],
}


def test_good_definition():
    assert f.validate_definition(GOOD) == []


def test_good_flow_with_triggers():
    for t in ({"kind": "manual"}, {"kind": "schedule", "cron": "30 7 * * 1-5"}, {"kind": "schedule", "everyMinutes": 60},
              {"kind": "watch", "condition": {"kind": "entity", "entityId": "a.b", "state": "on"}}):
        assert f.validate_flow("morning", GOOD, t) == []


def bad(mutate):
    d = copy.deepcopy(GOOD)
    mutate(d)
    return f.validate_definition(d)


def test_errors_carry_paths():
    errs = bad(lambda d: d["steps"][4].update({"wait": {"minutes": 5}}))
    assert any(e.startswith("steps[4].wait:") for e in errs)
    errs = bad(lambda d: d["steps"][3]["then"][0].update({"say": ""}))
    assert any(e.startswith("steps[3].then[0].say:") for e in errs)


@pytest.mark.parametrize("step,needle", [
    ({"bogus": "x"}, "exactly one step key"),
    ({"think": "a", "say": "b"}, "exactly one step key"),
    ({}, "exactly one step key"),
    ("text", "must be an object"),
    ({"think": ""}, "non-empty text"),
    ({"think": "a", "tools": "yes"}, "tools"),
    ({"think": "a", "options": []}, "not used by a think step"),
    ({"choose": "q", "options": ["only"]}, "options"),
    ({"tool": "t", "params": []}, "params"),
    ({"say": "a", "urgent": 1}, "urgent"),
    ({"wait": {"seconds": -1}}, "seconds"),
    ({"wait": 5}, "wait"),
    ({"wait_for": {"entityId": "x"}}, "wait_for"),
    ({"wait_for": {"signal": "s"}, "timeoutSeconds": 0}, "timeoutSeconds"),
    ({"if": {"var": "x", "op": "nope"}, "then": []}, "op"),
    ({"if": {"var": "x", "op": "eq"}, "then": []}, "value"),
    ({"if": {"var": "x", "op": "truthy"}}, "then"),
    ({"repeat": {"times": 5000}, "steps": []}, "times"),
    ({"repeat": {"times": 2}}, "steps"),
    ({"repeat": {"forever": True}, "steps": []}, "times"),
    ({"run_flow": "Bad Name"}, "flow name"),
    ({"set_intention": "x", "kind": "wish"}, "kind"),
    ({"say": "x", "as": "bad name"}, ".as"),
])
def test_bad_steps(step, needle):
    errs = f.validate_definition({"steps": [step]})
    assert errs and any(needle in e for e in errs), errs


def test_definition_shape_errors():
    assert f.validate_definition("nope")
    assert f.validate_definition({})
    assert f.validate_definition({"steps": []})
    assert f.validate_definition({"inputs": [], "steps": [{"say": "x"}]})


def nest(depth):
    step = {"say": "deep"}
    for _ in range(depth - 1):
        step = {"if": {"var": "x", "op": "truthy"}, "then": [step]}
    return {"steps": [step]}


def test_depth_limit():
    assert f.validate_definition(nest(6)) == []
    errs = f.validate_definition(nest(7))
    assert any("deep" in e for e in errs)


def test_step_count_limit():
    assert f.validate_definition({"steps": [{"say": "x"}] * 200}) == []
    errs = f.validate_definition({"steps": [{"say": "x"}] * 201})
    assert any("201 steps" in e for e in errs)


def test_names():
    assert f.valid_name("weather-and_bins9")
    for n in ("", "Upper", "has space", "x" * 65, None, 5):
        assert not f.valid_name(n)
    assert any("name" in e for e in f.validate_flow("Bad Name", GOOD, {"kind": "manual"}))


@pytest.mark.parametrize("trigger", [
    None, {"kind": "daily"}, {"kind": "schedule"}, {"kind": "schedule", "cron": "* * *"},
    {"kind": "schedule", "cron": "* * * * *", "everyMinutes": 5}, {"kind": "schedule", "everyMinutes": 0},
    {"kind": "watch"}, {"kind": "watch", "condition": {"kind": "entity"}},
])
def test_bad_triggers(trigger):
    assert f.validate_trigger(trigger)


def test_count_steps():
    assert f.count_steps(GOOD["steps"]) == 13 + 1 + 1 + 2 + 1  # nested then/else/repeat steps included
