import pytest

from aiembodied_workflows import conditions as c


@pytest.mark.parametrize("cond", [
    {"kind": "entity", "entityId": "binary_sensor.front_door", "state": "on"},
    {"kind": "entity", "entityId": "sensor.washer_power", "below": 5, "forSeconds": 180},
    {"kind": "entity", "entityId": "sensor.x", "above": 30},
    {"kind": "search", "query": "new gpu", "everyMinutes": 60},
    {"kind": "service", "url": "http://localhost:8080/health", "everyMinutes": 5},
    {"kind": "coding_task", "taskId": "20261108-1a2b"},
])
def test_good_conditions(cond):
    assert c.validate_condition(cond) == []
    assert c.describe(cond)


@pytest.mark.parametrize("cond", [
    None, {}, {"kind": "weather"},
    {"kind": "entity", "state": "on"},
    {"kind": "entity", "entityId": "a.b"},
    {"kind": "entity", "entityId": "a.b", "state": "on", "below": 3},
    {"kind": "entity", "entityId": "a.b", "below": "low"},
    {"kind": "entity", "entityId": "a.b", "below": 3, "forSeconds": -1},
    {"kind": "search"},
    {"kind": "search", "query": "x", "everyMinutes": 0},
    {"kind": "service", "url": "ftp://x"},
    {"kind": "coding_task"},
])
def test_bad_conditions(cond):
    assert c.validate_condition(cond)


def test_then():
    assert c.validate_then({"say": "hi"}) == []
    assert c.validate_then({"think": "look"}) == []
    assert c.validate_then({"flow": "weather", "inputs": {"a": 1}}) == []
    assert c.validate_then({"say": "a", "think": "b"})
    assert c.validate_then({})
    assert c.validate_then({"say": " "})
    assert c.validate_then({"flow": "x", "inputs": 3})
    assert c.validate_then("say")


def test_clamp_until_hours():
    assert c.clamp_until_hours(None) == 24
    assert c.clamp_until_hours("abc") == 24
    assert c.clamp_until_hours(5000) == 720
    assert c.clamp_until_hours(0) == 0.01
    assert c.clamp_until_hours(12) == 12


def test_entity_matches():
    on = {"kind": "entity", "entityId": "x", "state": "on"}
    assert c.entity_matches(on, "on") and c.entity_matches(on, "ON ") and not c.entity_matches(on, "off")
    assert not c.entity_matches(on, None)
    assert c.entity_matches(on, {"state": "on"})
    below = {"kind": "entity", "entityId": "x", "below": 5}
    assert c.entity_matches(below, "3.2") and not c.entity_matches(below, 5) and not c.entity_matches(below, "unavailable")
    above = {"kind": "entity", "entityId": "x", "above": 5}
    assert c.entity_matches(above, 7) and not c.entity_matches(above, "5")


def test_hold_timing():
    h = c.Hold(180)
    assert not h.update(0, True)
    assert h.remaining(60) == 120
    assert not h.update(100, True)
    assert h.update(180, True)
    assert not h.update(200, False)  # resets
    assert h.remaining(200) is None
    assert not h.update(300, True)
    assert not h.update(479, True) and h.update(480, True)


def test_hold_zero_fires_at_once():
    assert c.Hold(0).update(5, True)


def test_search_results():
    first = c.result_urls([{"url": "a"}, {"url": "b"}, {"title": "no url"}])
    assert first == ["a", "b"]
    new = c.new_results(first, [{"url": "a"}, {"url": "c", "title": "C"}, {"title": "x"}])
    assert new == [{"url": "c", "title": "C"}]


def test_service_down():
    assert c.service_is_down(None) and c.service_is_down(500) and c.service_is_down(404)
    assert not c.service_is_down(200) and not c.service_is_down(302)


def test_task_finished():
    for s in ("done", "failed", "cancelled", "DONE"):
        assert c.task_finished({"state": s})
    assert c.task_finished({"status": "done"})
    assert not c.task_finished({"state": "progress"}) and not c.task_finished({})
