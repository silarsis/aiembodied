import pytest

from aiembodied_workflows import life_rules as r

CALM = {"voicePhase": "idle", "conversationActive": False, "doNotDisturb": False, "asleep": False,
        "secondsSinceKevinSpoke": 600, "secondsSinceAvatarSpoke": 900}


def allowed(ctx=None, hour=14, quiet="22-7", since=None, sleep=False):
    return r.hard_rules({**CALM, **(ctx or {})}, hour=hour, quiet_hours=quiet, since_last_say=since, is_sleep_decision=sleep)


def test_hard_rules_allow_a_quiet_afternoon():
    assert allowed() == (True, "ok")


@pytest.mark.parametrize("ctx,why", [
    ({"asleep": True}, "asleep"),
    ({"doNotDisturb": True}, "do not disturb"),
    ({"conversationActive": True}, "in a conversation"),
    ({"voicePhase": "thinking"}, "in a conversation"),
    ({"voicePhase": "responding"}, "in a conversation"),
    ({"secondsSinceKevinSpoke": 30}, "someone spoke a moment ago"),
    ({"secondsSinceAvatarSpoke": 119}, "someone spoke a moment ago"),
])
def test_hard_rules_block(ctx, why):
    ok, reason = allowed(ctx)
    assert not ok and reason == why


def test_hard_rules_unknown_times_do_not_block():
    assert allowed({"secondsSinceKevinSpoke": None, "secondsSinceAvatarSpoke": None})[0]


def test_hard_rules_quiet_hours_unless_sleep():
    assert allowed(hour=23)[1] == "quiet hours"
    assert allowed(hour=3)[1] == "quiet hours"
    assert allowed(hour=23, sleep=True)[0]
    assert allowed(hour=23, quiet="")[0]


def test_hard_rules_say_gap():
    assert not allowed(since=19 * 60)[0]
    assert allowed(since=21 * 60)[0]
    assert allowed(since=None)[0]


def test_decision_interval():
    assert r.decision_interval_seconds("restless", 0.5) == 300
    assert r.decision_interval_seconds("normal", 0.5) == 600
    assert r.decision_interval_seconds("calm", 0.5) == 1200
    assert r.decision_interval_seconds("normal", 0.0) == pytest.approx(360)
    assert r.decision_interval_seconds("normal", 1.0) == pytest.approx(840)
    assert r.decision_interval_seconds(None, 0.5) is None


def test_return_home_chance():
    assert r.return_home_chance("calm") == 0.05
    assert r.return_home_chance("normal") == 0.1
    assert r.return_home_chance("restless") == 0.2
    assert r.return_home_chance(None) == 0.0


def test_arrival():
    assert r.is_arrival(10, 31 * 60)
    assert not r.is_arrival(10, 29 * 60)
    assert not r.is_arrival(200, 3600)  # no face now
    assert not r.is_arrival(None, 3600)
    assert not r.is_arrival(10, None)  # first sighting ever


def test_morning_plan_time():
    ctx = {"secondsSinceFaceSeen": 120}
    assert r.is_new_day_plan_time(ctx, "2026-11-26", 7, "2026-11-25")
    assert r.is_new_day_plan_time(ctx, "2026-11-26", 7, None)
    assert not r.is_new_day_plan_time(ctx, "2026-11-26", 7, "2026-11-26")  # done today
    assert not r.is_new_day_plan_time(ctx, "2026-11-26", 5, None)  # before 06:00
    assert not r.is_new_day_plan_time({"secondsSinceFaceSeen": 900}, "2026-11-26", 7, None)
    assert r.is_new_day_plan_time({"secondsSinceKevinSpoke": 60}, "2026-11-26", 7, None)


def test_reflect_time():
    assert r.is_reflect_time("2026-11-25", 22, "22-7", None)
    assert r.is_reflect_time("2026-11-26", 2, "22-7", "2026-11-25")
    assert not r.is_reflect_time("2026-11-25", 21, "22-7", None)
    assert not r.is_reflect_time("2026-11-25", 23, "22-7", "2026-11-25")
    assert not r.is_reflect_time("2026-11-25", 23, "", None)


@pytest.mark.parametrize("text,expected", [
    ("SAY: Morning, Kevin!", ("SAY", "Morning, Kevin!")),
    ('SAY: "The bins go out tonight."', ("SAY", "The bins go out tonight.")),
    ("say: hello", ("SAY", "hello")),
    ("READ: station-3", ("READ", "station-3")),
    ("SLEEP", ("SLEEP", "")),
    ("sleep.", ("SLEEP", "")),
    ("NOTHING", ("NOTHING", "")),
    ("I set a reminder.\nSAY: Done!", ("SAY", "Done!")),
    ("SAY: first\nSome trailing chatter", ("NOTHING", "")),  # only the last line counts
    ("**SLEEP**", ("SLEEP", "")),
    ("SAY:", ("NOTHING", "")),
    ("I think I will say hello", ("NOTHING", "")),
    ("", ("NOTHING", "")),
    (None, ("NOTHING", "")),
])
def test_parse_reply(text, expected):
    assert r.parse_reply(text) == expected


def test_decision_prompt_contents():
    ctx = {"localTime": "2026-11-26T09:30:00+08:00", "place": "lounge", "secondsSinceFaceSeen": 20,
           "secondsSinceKevinSpoke": 1800}
    p = r.decision_prompt("Echo", ctx, hours_awake=3.5, intentions=["[goal] learn to cook"], flows=["weather: bins"],
                          quiet_saves=["washing done"], offers=[{"stationId": "s1", "label": "Poetry shelf"}],
                          arrival_minutes=45)
    for needle in ("Echo", "2026-11-26T09:30", "lounge", "Kevin is in view", "3.5 hours", "learn to cook",
                   "weather: bins", '"washing done"', "Poetry shelf (id s1)", "45 minutes", "SAY:", "READ:", "SLEEP",
                   "NOTHING"):
        assert needle in p, needle


def test_decision_prompt_without_offers_has_no_read():
    p = r.decision_prompt("Echo", {}, hours_awake=1, intentions=[], flows=[], quiet_saves=[], offers=[])
    assert "READ:" not in p and "SAY:" in p


def test_unoffered_saves():
    assert r.unoffered_saves(["a", "b"], ["a"]) == ["b"]


def test_other_prompts_mention_the_tools():
    assert "set_intention" in r.plan_prompt("Echo", {}, hours_awake=1, intentions=[], flows=[])
    assert "SLEEP" in r.reflect_prompt("Echo", {}, hours_awake=1, intentions=[], flows=[])
    assert "look at this: tea" in r.wakeme_prompt("tea")
