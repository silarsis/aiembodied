import asyncio
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from memory_engine import home
from memory_engine.home import classify, deadband, describe_change, keep_reading, ws_url

T0 = datetime(2026, 11, 3, 8, 0, tzinfo=timezone.utc)


def iso(seconds):
    return (T0 + timedelta(seconds=seconds)).isoformat()


@pytest.fixture
def second_database(database_url):
    """A second, empty database on the same server."""
    import psycopg
    from urllib.parse import urlsplit, urlunsplit

    name = f"memtest_{uuid4().hex[:10]}"
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f"CREATE DATABASE {name}")
    yield urlunsplit(urlsplit(database_url)._replace(path=f"/{name}"))
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


# --- pure functions ---


def test_ws_url():
    assert ws_url("http://homeassistant-1:8123") == "ws://homeassistant-1:8123/api/websocket"
    assert ws_url("https://ha.example.com/") == "wss://ha.example.com/api/websocket"
    assert ws_url("http://host:8123/api/websocket") == "ws://host:8123/api/websocket"
    with pytest.raises(ValueError):
        ws_url("homeassistant:8123")


def test_classify():
    assert classify("sensor", None, "diagnostic", "1", {"unit_of_measurement": "V"}) == "ignore"
    assert classify("switch", None, "config", "on") == "ignore"
    assert classify("alarm_control_panel", None, None, "disarmed") == "alert"
    for device_class in ("smoke", "gas", "carbon_monoxide", "moisture", "safety", "problem", "tamper", "heat", "cold"):
        assert classify("binary_sensor", device_class, None, "off") == "alert"
    assert classify("binary_sensor", "door", None, "off") == "state"
    assert classify("sensor", "temperature", None, "21.5", {"unit_of_measurement": "°C"}) == "numeric"
    assert classify("input_number", None, None, "3", {"state_class": "measurement"}) == "numeric"
    assert classify("sensor", None, None, "21.5") == "state"  # no unit, no state class
    assert classify("sensor", None, None, "sunny", {"unit_of_measurement": "x"}) == "state"
    assert classify("sensor", "temperature", None, "unavailable", {"unit_of_measurement": "°C"}) == "numeric"
    assert classify("light", None, None, "on") == "state"


def test_deadband():
    assert deadband("temperature", 21.0) == 0.3
    assert deadband("humidity", 50) == 2
    assert deadband("pressure", 1013) == 1
    assert deadband("illuminance", 500) == pytest.approx(50)
    assert deadband("power", 1000) == pytest.approx(50)
    assert deadband("voltage", -230) == pytest.approx(11.5)
    assert deadband("battery", 80) == 5
    assert deadband(None, 10) == 0.5
    assert deadband("co2", 2000) == pytest.approx(40)
    assert deadband("power", 0) > 0  # sitting at zero must not keep every update


def test_keep_reading():
    kept = T0
    assert keep_reading(20.0, None, None, T0, 0.3)
    assert not keep_reading(20.1, 20.0, kept, T0 + timedelta(minutes=1), 0.3)
    assert keep_reading(20.3, 20.0, kept, T0 + timedelta(minutes=1), 0.3)
    assert keep_reading(19.6, 20.0, kept, T0 + timedelta(minutes=1), 0.3)
    assert keep_reading(20.0, 20.0, kept, T0 + timedelta(minutes=15), 0.3)
    assert not keep_reading(20.0, 20.0, kept, T0 + timedelta(minutes=14), 0.3)


def test_describe_change():
    assert describe_change("Front door", "Hallway", "binary_sensor", "door", "off", "on") == "Front door (Hallway) opened, was closed."
    assert describe_change("Front door", "Hallway", "binary_sensor", "door", "on", "off") == "Front door (Hallway) closed, was open."
    assert describe_change("Hall motion", None, "binary_sensor", "motion", "off", "on") == "Hall motion detected, was clear."
    assert describe_change("Sink", "Kitchen", "binary_sensor", "moisture", "off", "on") == "Sink (Kitchen) wet, was dry."
    assert describe_change("Smoke", "Hall", "binary_sensor", "smoke", "off", "on") == "Smoke (Hall) detected, was clear."
    assert describe_change("Front lock", "Hall", "lock", None, "locked", "unlocked") == "Front lock (Hall) unlocked, was locked."
    assert describe_change("Lamp", "Study", "light", None, "off", "on") == "Lamp (Study) turned on, was off."
    assert describe_change("Plug", None, "binary_sensor", "plug", "on", "off") == "Plug turned off, was on."
    assert describe_change("Alarm", None, "alarm_control_panel", None, "disarmed", "armed_away") == "Alarm changed to armed away, was disarmed."
    assert describe_change("Temp", "Kitchen", "sensor", None, "21.5", "unavailable", "°C") == "Temp (Kitchen) changed to unavailable, was 21.5 °C."
    assert describe_change("Door", None, "binary_sensor", "door", None, "on") == "Door opened."


# --- the handler against a database ---


def entity_state(entity_id, state, seconds, **attributes):
    return {"entity_id": entity_id, "state": state, "attributes": attributes,
            "last_changed": iso(seconds), "last_updated": iso(seconds)}


def event(entity_id, new, old=None):
    return {"event_type": "state_changed", "data": {"entity_id": entity_id, "new_state": new, "old_state": old}}


def seed(conn):
    config = home.HomeConfig(url="http://ha:8123", token="t")
    home.upsert_home(conn, config, connected=True)
    home.upsert_entity(conn, "home", entity_state("binary_sensor.front_door", "off", 0, friendly_name="Front door", device_class="door"), area="Hallway")
    home.upsert_entity(conn, "home", entity_state("sensor.kitchen_temp", "20.0", 0, friendly_name="Kitchen temperature", device_class="temperature", unit_of_measurement="°C"), area="Kitchen")
    home.upsert_entity(conn, "home", entity_state("binary_sensor.smoke", "off", 0, friendly_name="Hall smoke alarm", device_class="smoke"), area="Hallway")
    for entity_id, state in (("binary_sensor.front_door", "off"), ("sensor.kitchen_temp", "20.0"), ("binary_sensor.smoke", "off")):
        home.record_state(conn, "home", entity_id, entity_state(entity_id, state, 0))


@pytest.fixture
def db(client):
    engine = client.app.state.engine
    with engine.pool.connection() as conn:
        seed(conn)
    return engine


def handle(engine, new, old=None, entity_id=None):
    with engine.pool.connection() as conn:
        result = home.handle_event(conn, "home", event(entity_id or new["entity_id"], new, old))
        if result and result["indexed"]:
            engine.wake_embedder(conn)
    return result


def test_state_change_is_stored_and_indexed(client, db):
    result = handle(db, entity_state("binary_sensor.front_door", "on", 60, friendly_name="Front door"))
    assert result == {"kind": "change", "indexed": True}
    # An attribute-only update is not a change.
    assert handle(db, entity_state("binary_sensor.front_door", "on", 90, friendly_name="Front door")) is None
    with db.pool.connection() as conn:
        events = conn.execute("SELECT kind, state, old_state FROM ha_events WHERE entity_id = 'binary_sensor.front_door'").fetchall()
        rows = conn.execute("SELECT kind, source, text, importance, session_id, agent FROM recall_index WHERE source = 'home_assistant'").fetchall()
    assert events == [("change", "on", "off")]
    assert rows == [("ha_event", "home_assistant", "Front door (Hallway) opened, was closed.", 0.4, None, None)]


def test_alert_is_prefixed_and_important(client, db):
    assert handle(db, entity_state("binary_sensor.smoke", "on", 60))["kind"] == "alert"
    with db.pool.connection() as conn:
        text, importance = conn.execute("SELECT text, importance FROM recall_index WHERE source = 'home_assistant'").fetchone()
        kind = conn.execute("SELECT kind FROM ha_events WHERE entity_id = 'binary_sensor.smoke'").fetchone()[0]
    assert text == "Alert: Hall smoke alarm (Hallway) detected, was clear."
    assert importance == 0.9 and kind == "alert"


def test_readings_use_a_deadband_and_roll_up_every_value(client, db):
    for seconds, value in ((60, "20.1"), (120, "20.5"), (180, "20.6"), (240, "19.9")):
        handle(db, entity_state("sensor.kitchen_temp", value, seconds))
    with db.pool.connection() as conn:
        raw = conn.execute("SELECT value FROM ha_events WHERE kind = 'reading' ORDER BY at").fetchall()
        rollup = conn.execute("SELECT n, min, max, sum, last FROM ha_readings").fetchall()
        indexed = conn.execute("SELECT count(*) FROM recall_index WHERE source = 'home_assistant'").fetchone()[0]
    # The seed kept 20.0; 20.1 is inside the band; 20.5 and 19.9 are kept; 20.6 is inside again.
    assert [r[0] for r in raw] == [20.0, 20.5, 19.9]
    assert len(rollup) == 1
    n, low, high, total, last = rollup[0]
    assert (n, low, high, last) == (5, 19.9, 20.6, 19.9)
    assert total == pytest.approx(20.0 + 20.1 + 20.5 + 20.6 + 19.9)
    assert indexed == 0  # readings are not indexed


def test_numeric_going_unavailable_is_a_change(client, db):
    assert handle(db, entity_state("sensor.kitchen_temp", "unavailable", 60))["kind"] == "change"
    assert handle(db, entity_state("sensor.kitchen_temp", "unavailable", 70)) is None
    with db.pool.connection() as conn:
        state, value, old = conn.execute("SELECT state, value, old_state FROM ha_events WHERE kind = 'change'").fetchone()
        text = conn.execute("SELECT text FROM recall_index WHERE source = 'home_assistant'").fetchone()[0]
    assert (state, value, old) == ("unavailable", None, "20.0")
    assert text == "Kitchen temperature (Kitchen) changed to unavailable, was 20.0 °C."
    # And the number coming back is kept as a reading.
    assert handle(db, entity_state("sensor.kitchen_temp", "20.0", 120)) == {"kind": "reading", "indexed": False}


def test_unwatched_entities_are_ignored(client, db):
    assert handle(db, entity_state("light.study", "on", 60)) is None
    with db.pool.connection() as conn:
        assert conn.execute("SELECT count(*) FROM ha_events").fetchone()[0] == 1  # the seeded reading only


def test_catch_up_records_a_change_that_happened_while_away(client, db):
    with db.pool.connection() as conn:
        state = entity_state("binary_sensor.front_door", "on", 500, friendly_name="Front door", device_class="door")
        home.upsert_entity(conn, "home", state, area="Hallway")
        assert home.record_state(conn, "home", "binary_sensor.front_door", state, catch_up=True)["indexed"]
        assert home.record_state(conn, "home", "binary_sensor.front_door", state, catch_up=True) is None
        at = conn.execute("SELECT at FROM ha_events WHERE kind = 'change'").fetchone()[0]
    assert at == T0 + timedelta(seconds=500)


def test_home_assistant_stays_out_of_conversation_search_and_recall(client, db):
    handle(db, entity_state("binary_sensor.front_door", "on", 60, friendly_name="Front door"))

    def search(**params):
        return client.get("/v1/search", params={"q": "front door", **params}).json()["results"]

    assert search() == []
    assert search(mode="text") == []
    found = search(source="home_assistant")
    assert [r["source"] for r in found] == ["home_assistant"]
    assert found[0]["kind"] == "ha_event" and "opened" in found[0]["text"]
    assert [r["source"] for r in search(source="all")] == ["home_assistant"]
    assert [r["source"] for r in search(source="all", mode="text")] == ["home_assistant"]
    assert client.get("/v1/search", params={"q": "x", "source": "bogus"}).status_code == 422

    sid = uuid4()
    client.put(f"/v1/sessions/{sid}", json={"started_at": iso(0)})
    client.post("/v1/messages", json={"messages": [
        {"id": str(uuid4()), "session_id": str(sid), "role": "user", "content": "the front door opened was closed", "created_at": iso(0)}]})
    assert [r["source"] for r in search()] == ["conversation"]
    assert sorted(r["source"] for r in search(source="all")) == ["conversation", "home_assistant"]

    recalled = client.post("/v1/recall", json={"text": "Front door (Hallway) opened, was closed."}).json()
    assert all(item.get("source", "conversation") == "conversation" for item in recalled.get("items", []))
    assert client.get("/health").json()["counts"]["indexed"] == 1  # conversation only


def test_mirror_skips_home_assistant_rows(client, db, schema, second_database):
    from memory_engine import mirror

    handle(db, entity_state("binary_sensor.front_door", "on", 60, friendly_name="Front door"))
    with db.pool.connection() as source, mirror.connect_target(second_database, schema) as target:
        mirror.push(source, target, {})
        assert target.execute("SELECT count(*) FROM recall_index").fetchone()[0] == 0


def test_status_entities_and_history_routes(client, db):
    assert client.get("/v1/home/status").json() == {"homes": []}
    assert client.get("/health").json()["home"] == {"configured": False, "connected": 0, "homes": 0}

    entities = client.get("/v1/home/entities").json()["entities"]
    assert [e["entity_id"] for e in entities] == ["binary_sensor.front_door", "binary_sensor.smoke", "sensor.kitchen_temp"]
    assert set(entities[0]) == {"home_id", "home_name", "entity_id", "name", "area", "domain", "device_class", "class", "unit", "last_state", "last_value"}
    assert [e["entity_id"] for e in client.get("/v1/home/entities", params={"q": "kitchen"}).json()["entities"]] == ["sensor.kitchen_temp"]
    assert [e["entity_id"] for e in client.get("/v1/home/entities", params={"q": "hallway"}).json()["entities"]] == ["binary_sensor.front_door", "binary_sensor.smoke"]

    now = datetime.now(timezone.utc)
    with db.pool.connection() as conn:
        door = lambda state, ago: entity_state("binary_sensor.front_door", state, 0) | {"last_changed": (now - ago).isoformat(), "last_updated": (now - ago).isoformat()}  # noqa: E731
        home.handle_event(conn, "home", event("binary_sensor.front_door", door("on", timedelta(hours=3))))
        home.handle_event(conn, "home", event("binary_sensor.front_door", door("off", timedelta(hours=2))))
        for ago, value in ((90, 21.0), (80, 22.0), (30, 23.5)):
            state = entity_state("sensor.kitchen_temp", str(value), 0) | {"last_updated": (now - timedelta(minutes=ago)).isoformat(), "last_changed": (now - timedelta(minutes=ago)).isoformat()}
            home.handle_event(conn, "home", event("sensor.kitchen_temp", state))

    history = client.get("/v1/home/history", params={"entity": "binary_sensor.front_door"}).json()
    assert history["entity"]["name"] == "Front door"
    assert [c["state"] for c in history["changes"]] == ["off", "on"]  # newest first
    assert history["changes"][0]["text"] == "Front door (Hallway) closed, was open."
    assert history["readings"] == [] and history["raw"] == []

    history = client.get("/v1/home/history", params={"q": "kitchen temperature"}).json()
    assert history["entity"]["entity_id"] == "sensor.kitchen_temp"
    assert history["changes"] == []
    assert len(history["raw"]) >= 3 and history["raw"][-1]["value"] == 23.5
    assert sum(r["n"] for r in history["readings"]) == 3  # the seed value is from another day
    assert set(history["readings"][0]) == {"hour", "n", "min", "mean", "max", "last"}

    # Over two days there is no raw list, only rollups.
    long = client.get("/v1/home/history", params={"q": "kitchen temperature", "from": (now - timedelta(days=5)).isoformat()}).json()
    assert long["raw"] == [] and long["readings"]

    # Several candidates: just the matches. A name that fits one exactly is chosen.
    with db.pool.connection() as conn:
        home.upsert_entity(conn, "home", entity_state("sensor.hall_temp", "19", 0, friendly_name="Hall temperature", device_class="temperature", unit_of_measurement="°C"), area="Hallway")
    many = client.get("/v1/home/history", params={"q": "temperature"}).json()
    assert "entity" not in many and {m["entity_id"] for m in many["matches"]} == {"sensor.kitchen_temp", "sensor.hall_temp"}
    assert client.get("/v1/home/history", params={"q": "Kitchen temperature"}).json()["entity"]["entity_id"] == "sensor.kitchen_temp"
    assert client.get("/v1/home/history", params={"q": "nothing like it"}).json() == {"matches": []}

    assert client.get("/v1/home/history").status_code == 400
    bad = client.get("/v1/home/history", params={"entity": "x", "from": iso(100), "to": iso(0)})
    assert bad.status_code == 400


def test_prune_removes_old_raw_readings_only(client, db):
    with db.pool.connection() as conn:
        conn.execute("UPDATE ha_events SET at = now() - interval '10 days'")
        conn.execute("INSERT INTO ha_events (id, home_id, entity_id, kind, at, state) VALUES (%s, 'home', 'x', 'change', now() - interval '10 days', 'on')", (uuid4(),))
        assert home.prune(conn, 7) == 1
        assert conn.execute("SELECT kind FROM ha_events").fetchall() == [("change",)]
        assert conn.execute("SELECT count(*) FROM ha_readings").fetchone()[0] == 1


# --- a scripted Home Assistant over a real WebSocket ---


class FakeHomeAssistant:
    """Speaks enough of the WebSocket API: auth, registries, states, one event."""

    def __init__(self, token="secret", accept=True):
        self.token = token
        self.accept = accept
        self.seen = []
        self.loop = asyncio.new_event_loop()
        self.ready = threading.Event()
        self.port = 0
        threading.Thread(target=self._run, daemon=True).start()
        assert self.ready.wait(10)

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._serve())

    async def _serve(self):
        from websockets.asyncio.server import serve

        async with serve(self._handle, "127.0.0.1", 0) as server:
            self.port = server.sockets[0].getsockname()[1]
            self.ready.set()
            await asyncio.Future()

    async def _handle(self, ws):
        await ws.send(json.dumps({"type": "auth_required"}))
        auth = json.loads(await ws.recv())
        if not self.accept or auth.get("access_token") != self.token:
            await ws.send(json.dumps({"type": "auth_invalid"}))
            return
        await ws.send(json.dumps({"type": "auth_ok"}))
        async for raw in ws:
            msg = json.loads(raw)
            kind = msg["type"]
            self.seen.append(kind)
            result = {
                "config/label_registry/list": [{"label_id": "aiembodied", "name": "AIEmbodied"}],
                "config/entity_registry/list": [
                    {"entity_id": "binary_sensor.front_door", "labels": ["aiembodied"], "device_id": "d1", "area_id": None, "name": None, "original_name": "Front door"},
                    {"entity_id": "light.study", "labels": [], "device_id": None, "area_id": "study"},
                    {"entity_id": "sensor.battery", "labels": ["aiembodied"], "entity_category": "diagnostic"},
                    {"entity_id": "switch.off", "labels": ["aiembodied"], "disabled_by": "user"},
                ],
                "config/device_registry/list": [{"id": "d1", "area_id": "hall"}],
                "config/area_registry/list": [{"area_id": "hall", "name": "Hallway"}, {"area_id": "study", "name": "Study"}],
                "get_states": [
                    {"entity_id": "binary_sensor.front_door", "state": "off", "attributes": {"friendly_name": "Front door", "device_class": "door"}, "last_changed": iso(0), "last_updated": iso(0)},
                    {"entity_id": "light.study", "state": "on", "attributes": {}, "last_changed": iso(0), "last_updated": iso(0)},
                    {"entity_id": "sensor.battery", "state": "50", "attributes": {"unit_of_measurement": "%"}, "last_changed": iso(0), "last_updated": iso(0)},
                    {"entity_id": "sensor.patio_temp", "state": "9.5", "attributes": {"friendly_name": "Patio temperature", "unit_of_measurement": "°C", "device_class": "temperature"}, "last_changed": iso(0), "last_updated": iso(0)},
                ],
            }.get(kind, None)
            await ws.send(json.dumps({"id": msg["id"], "type": "result", "success": True, "result": result}))
            if kind == "get_states" and self.seen.count("get_states") == 1:
                await asyncio.sleep(0.3)
                new = {"entity_id": "binary_sensor.front_door", "state": "on", "attributes": {"friendly_name": "Front door", "device_class": "door"}, "last_changed": iso(60), "last_updated": iso(60)}
                await ws.send(json.dumps({"id": 2, "type": "event", "event": {"event_type": "state_changed", "data": {"entity_id": "binary_sensor.front_door", "new_state": new, "old_state": None}}}))


def wait_for(check, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError("timed out")


def test_listener_against_a_scripted_home_assistant(database_url, schema):
    from memory_engine.app import Engine
    from memory_engine.embed import FakeEmbedder

    fake = FakeHomeAssistant()
    config = home.HomeConfig(url=f"http://127.0.0.1:{fake.port}", token="secret", entities=["sensor.patio_*"])
    engine = Engine(database_url, schema, embedder=FakeEmbedder(), home_config=config)
    engine.start(in_background=True)
    try:
        # "connected" turns on before the first full refresh fills the watched set, so wait for both.
        wait_for(lambda: engine.home_status()["homes"][0]["connected"] and engine.home_status()["homes"][0]["watched"] == 3)
        status = engine.home_status()["homes"][0]
        assert status["id"] == "home" and status["source"] == "env" and status["configured"] and status["watched"] == 3 and status["url"] == config.url
        assert "secret" not in json.dumps(status)

        def stored():
            with engine.pool.connection() as conn:
                return conn.execute("SELECT state, old_state FROM ha_events WHERE kind = 'change'").fetchall()

        assert wait_for(stored) == [("on", "off")]
        with engine.pool.connection() as conn:
            entities = conn.execute("SELECT entity_id, name, area, class FROM ha_entities ORDER BY entity_id").fetchall()
            text = conn.execute("SELECT text FROM recall_index WHERE source = 'home_assistant'").fetchone()[0]
            url = conn.execute("SELECT url FROM homes").fetchone()[0]
        # The battery is "diagnostic" in HA, but it carries the label, so it is kept.
        assert entities == [("binary_sensor.front_door", "Front door", "Hallway", "state"),
                            ("sensor.battery", "sensor.battery", None, "numeric"),
                            ("sensor.patio_temp", "Patio temperature", None, "numeric")]
        assert text == "Front door (Hallway) opened, was closed."
        assert url == config.url
        assert engine.home_status()["homes"][0]["events_today"] == 1
    finally:
        engine.stop()


def test_listener_reports_a_refused_token(database_url, schema):
    from memory_engine.app import Engine

    fake = FakeHomeAssistant(accept=False)
    engine = Engine(database_url, schema, home_config=home.HomeConfig(url=f"http://127.0.0.1:{fake.port}", token="nope"))
    engine.start(in_background=True)
    try:
        status = wait_for(lambda: engine.home_status()["homes"][0]["error"] and engine.home_status()["homes"][0])
        assert status["error"] == "token refused" and status["connected"] is False
    finally:
        engine.stop()


def test_listener_is_off_without_a_token(database_url, schema):
    from memory_engine.app import Engine

    engine = Engine(database_url, schema, home_config=home.HomeConfig(url="http://ha:8123"))
    assert engine.homes.listeners == {}
    status = engine.home_status()["homes"][0]
    assert status["configured"] is False and "HA_TOKEN" in status["note"]
    engine.pool.close()


def test_named_entity_overrides_diagnostic_category():
    """An entity named exactly in HA_ENTITIES is watched even when HA marks it diagnostic."""
    from memory_engine.home import classify

    attributes = {"unit_of_measurement": "%", "device_class": "battery"}
    assert classify("sensor", "battery", "diagnostic", "80", attributes) == "ignore"
    assert classify("sensor", "battery", None, "80", attributes) == "numeric"


# --- several homes ---


def test_homes_from_env():
    env = {
        "HA_URL": "http://one:8123", "HA_TOKEN": "t1", "HA_HOME_ID": "main", "HA_HOME_NAME": "Melbourne",
        "HA_LABEL": "remember", "HA_ENTITIES": "light.*, sensor.a", "HA_RAW_DAYS": "3",
        "HA_SG_URL": "http://sg:8123", "HA_SG_TOKEN": "t2",
        "HA_PENANG_URL": "http://penang:8123", "HA_PENANG_TOKEN": "t3", "HA_PENANG_NAME": "Penang house",
        "HA_PENANG_LABEL": "mine", "HA_PENANG_ENTITIES": "lock.door",
        "HA_LONELY_URL": "http://x:8123",  # no token: not a home
        "HA_NOURL_TOKEN": "t",  # no url: not a home
        "HA_HOME_URL": "http://reserved", "HA_HOME_TOKEN": "t",  # reserved word
        "PATH": "/bin",
    }
    homes = {h.home_id: h for h in home.homes_from_env(env)}
    assert set(homes) == {"main", "sg", "penang"}
    main, sg, penang = homes["main"], homes["sg"], homes["penang"]
    assert (main.url, main.token, main.name, main.label, main.entities, main.raw_days, main.source) == (
        "http://one:8123", "t1", "Melbourne", "remember", ["light.*", "sensor.a"], 3.0, "env")
    assert (sg.url, sg.token, sg.name, sg.label, sg.entities, sg.raw_days) == (
        "http://sg:8123", "t2", "SG", "remember", [], 3.0)
    assert (penang.name, penang.label, penang.entities) == ("Penang house", "mine", ["lock.door"])
    assert "t1" not in repr(main)

    assert home.homes_from_env({}) == []
    only = home.homes_from_env({"HA_URL": "http://one:8123", "HA_TOKEN": "t"})
    assert [(h.home_id, h.name, h.label, h.raw_days) for h in only] == [("home", "Home", "aiembodied", 7.0)]
    # The default home is listed with what is missing, so the status can say so.
    missing = home.homes_from_env({"HA_URL": "http://one:8123"})
    assert missing[0].off_reason == "HA_TOKEN is not set"
    assert home.homes_from_env({"HA_SG_URL": "http://sg", "HA_SG_TOKEN": "t", "HA_RAW_DAYS": "bogus"})[0].raw_days == 7.0


def test_describe_change_names_the_home():
    assert describe_change("Front door", "Hallway", "binary_sensor", "door", "off", "on", home_name="SG") == "Front door (Hallway, SG) opened, was closed."
    assert describe_change("Front door", None, "binary_sensor", "door", "off", "on", home_name="SG") == "Front door (SG) opened, was closed."
    assert describe_change("Front door", "Hallway", "binary_sensor", "door", "off", "on", home_name="Home") == "Front door (Hallway) opened, was closed."


def test_indexed_text_and_entities_carry_the_home_name(client, db):
    with db.pool.connection() as conn:
        sg = home.HomeConfig(url="http://sg:8123", token="t", home_id="sg", name="SG")
        home.upsert_home(conn, sg, connected=True)
        home.upsert_entity(conn, "sg", entity_state("binary_sensor.front_door", "off", 0, friendly_name="Front door", device_class="door"), area="Hallway")
        home.upsert_entity(conn, "sg", entity_state("binary_sensor.gate", "off", 0, friendly_name="Gate", device_class="door"))
        for entity_id in ("binary_sensor.front_door", "binary_sensor.gate"):
            home.record_state(conn, "sg", entity_id, entity_state(entity_id, "off", 0))
        home.handle_event(conn, "sg", event("binary_sensor.front_door", entity_state("binary_sensor.front_door", "on", 60)))
        home.handle_event(conn, "sg", event("binary_sensor.gate", entity_state("binary_sensor.gate", "on", 60)))
        home.handle_event(conn, "home", event("binary_sensor.front_door", entity_state("binary_sensor.front_door", "on", 60)))
        texts = {r[0] for r in conn.execute("SELECT text FROM recall_index WHERE source = 'home_assistant'").fetchall()}
    assert texts == {"Front door (Hallway, SG) opened, was closed.", "Gate (SG) opened, was closed.", "Front door (Hallway) opened, was closed."}

    entities = client.get("/v1/home/entities").json()["entities"]
    names = {(e["home_id"], e["entity_id"]): e["home_name"] for e in entities}
    assert names[("sg", "binary_sensor.gate")] == "SG" and names[("home", "binary_sensor.front_door")] == "Home"
    assert {e["home_id"] for e in client.get("/v1/home/entities", params={"home": "sg"}).json()["entities"]} == {"sg"}
    assert {e["home_id"] for e in client.get("/v1/home/entities", params={"q": "SG hallway"}).json()["entities"]} == {"sg"}
    # The same entity id in two homes needs the home to single one out.
    both = client.get("/v1/home/history", params={"entity": "binary_sensor.front_door"}).json()
    assert {m["home_id"] for m in both["matches"]} == {"home", "sg"}
    one = client.get("/v1/home/history", params={"entity": "binary_sensor.front_door", "home": "sg", "from": iso(-3600), "to": iso(3600)}).json()
    assert one["entity"]["home_name"] == "SG"
    assert one["changes"][0]["text"] == "Front door (Hallway, SG) opened, was closed."


def make_app(database_url, schema, **kwargs):
    from fastapi.testclient import TestClient

    from memory_engine.app import Engine, create_app
    from memory_engine.embed import FakeEmbedder

    engine = Engine(database_url, schema, embedder=FakeEmbedder(), **kwargs)
    return engine, TestClient(create_app(engine))


def put_servers(client, *servers):
    return client.put("/v1/home/servers", json={"servers": list(servers)})


def server(fake, id, name, token="secret", **extra):
    return {"id": id, "name": name, "url": f"http://127.0.0.1:{fake.port}", "token": token, "label": None, "entities": [], **extra}


def by_id(response):
    return {h["id"]: h for h in response.json()["homes"]}


def test_app_servers_add_replace_and_remove_listeners(database_url, schema):
    penang_fake, sg_fake = FakeHomeAssistant(token="penang-secret"), FakeHomeAssistant(token="sg-secret")
    env = home.HomeConfig(url=f"http://127.0.0.1:{sg_fake.port}", token="sg-secret", home_id="sg", name="SG")
    engine, http = make_app(database_url, schema, home_configs=[env])
    with http as client:
        wait_for(lambda: by_id(client.get("/v1/home/status"))["sg"]["connected"])
        assert by_id(client.get("/v1/home/status"))["sg"]["source"] == "env"

        # Add an app home next to the environment's.
        response = put_servers(client, server(penang_fake, "srv-1", "Penang", token="penang-secret"))
        assert response.status_code == 200
        assert "penang-secret" not in response.text and "sg-secret" not in response.text
        homes = by_id(response)
        assert set(homes) == {"sg", "srv-1"} and homes["srv-1"]["source"] == "app" and homes["srv-1"]["name"] == "Penang"
        assert set(homes["srv-1"]) == {"id", "name", "source", "configured", "connected", "url", "label", "watched", "events_today", "last_event_at", "error", "note"}
        wait_for(lambda: by_id(client.get("/v1/home/status"))["srv-1"]["connected"])
        status = client.get("/v1/home/status")
        assert "penang-secret" not in status.text and "sg-secret" not in status.text
        assert by_id(status)["srv-1"]["watched"] == 2 and by_id(status)["sg"]["connected"]
        health = client.get("/health").json()["home"]
        assert health == {"configured": True, "connected": 2, "homes": 2}
        env_listener = engine.homes.listeners["sg"]
        app_listener = engine.homes.listeners["srv-1"]

        # The same set again: nothing restarts.
        put_servers(client, server(penang_fake, "srv-1", "Penang", token="penang-secret"))
        assert engine.homes.listeners["sg"] is env_listener and engine.homes.listeners["srv-1"] is app_listener

        # A changed token restarts that listener (the fake refuses it); the other keeps running.
        homes = by_id(put_servers(client, server(penang_fake, "srv-1", "Penang", token="wrong")))
        assert engine.homes.listeners["srv-1"] is not app_listener and engine.homes.listeners["sg"] is env_listener
        wait_for(lambda: by_id(client.get("/v1/home/status"))["srv-1"]["error"] == "token refused")
        assert "wrong" not in client.get("/v1/home/status").text

        # A new name restarts it too, and the name reaches the database.
        put_servers(client, server(penang_fake, "srv-1", "Penang house", token="penang-secret"))
        wait_for(lambda: by_id(client.get("/v1/home/status"))["srv-1"]["connected"])
        with engine.pool.connection() as conn:
            assert conn.execute("SELECT name FROM homes WHERE id = 'srv-1'").fetchone()[0] == "Penang house"

        # An app home with an environment home's id replaces it; removing it brings the other back.
        put_servers(client, server(penang_fake, "sg", "Singapore (app)", token="penang-secret"))
        homes = by_id(client.get("/v1/home/status"))
        assert set(homes) == {"sg"} and homes["sg"]["source"] == "app" and homes["sg"]["name"] == "Singapore (app)"
        assert engine.homes.listeners["sg"] is not env_listener
        response = put_servers(client)
        assert response.status_code == 200
        homes = by_id(response)
        assert set(homes) == {"sg"} and homes["sg"]["source"] == "env"
        wait_for(lambda: by_id(client.get("/v1/home/status"))["sg"]["connected"])
        assert set(engine.homes.listeners) == {"sg"}


def test_two_homes_are_remembered_under_their_own_names(database_url, schema):
    fake_a, fake_b = FakeHomeAssistant(), FakeHomeAssistant()
    engine, http = make_app(database_url, schema)
    with http as client:
        put_servers(client, server(fake_a, "a", "Penang"), server(fake_b, "b", "Home"))
        wait_for(lambda: all(h["connected"] for h in by_id(client.get("/v1/home/status")).values()) and len(by_id(client.get("/v1/home/status"))) == 2)
        texts = wait_for(lambda: len(rows(engine)) == 2 and sorted(rows(engine)))
        assert texts == ["Front door (Hallway) opened, was closed.", "Front door (Hallway, Penang) opened, was closed."]
        entities = client.get("/v1/home/entities").json()["entities"]
        assert {(e["home_id"], e["home_name"]) for e in entities} == {("a", "Penang"), ("b", "Home")}
        assert len({e["home_id"] for e in client.get("/v1/home/entities", params={"home": "a"}).json()["entities"]}) == 1


def rows(engine):
    with engine.pool.connection() as conn:
        return [r[0] for r in conn.execute("SELECT text FROM recall_index WHERE source = 'home_assistant'").fetchall()]


def test_put_home_servers_validates_and_never_echoes_a_token(database_url, schema):
    fake = FakeHomeAssistant()
    engine, http = make_app(database_url, schema)
    with http as client:
        wait_for(lambda: engine.ready)  # stopping during the migrations can deadlock the schema's drop
        good = server(fake, "a", "A")
        for bad in (
            {**good, "url": "ftp://host"},
            {**good, "url": "homeassistant.local:8123"},
            {**good, "url": "http://"},
            {**good, "url": 5},
            {**good, "id": ""},
            {**good, "token": 12345},
            {**good, "entities": "light.*"},
        ):
            response = client.put("/v1/home/servers", json={"servers": [bad]})
            assert response.status_code == 400, bad
            assert "secret" not in response.text
        assert client.put("/v1/home/servers", json={"servers": [good, good]}).status_code == 400
        assert client.put("/v1/home/servers", json={"nope": []}).status_code == 400
        assert client.put("/v1/home/servers", content="not json").status_code == 400
        too_many = [{**good, "id": f"s{i}"} for i in range(21)]
        assert client.put("/v1/home/servers", json={"servers": too_many}).status_code == 400
        assert client.get("/v1/home/status").json() == {"homes": []}  # a refused request changes nothing
        ok = client.put("/v1/home/servers", json={"servers": [{**good, "id": f"s{i}"} for i in range(20)]})
        assert ok.status_code == 200 and len(ok.json()["homes"]) == 20

        # No token: listed, but off. Credentials in the address are not shown.
        response = put_servers(client, {"id": "x", "name": "X", "url": "http://user:pw@host:8123", "token": ""})
        entry = by_id(response)["x"]
        assert entry["configured"] is False and entry["url"] == "http://host:8123" and "pw" not in response.text
        assert "x" not in engine.homes.listeners


def test_put_home_servers_needs_the_api_token(database_url, schema):
    from fastapi.testclient import TestClient

    from memory_engine.app import Engine, create_app

    engine = Engine(database_url, schema)
    with TestClient(create_app(engine, api_token="k")) as client:
        wait_for(lambda: engine.ready)
        assert client.put("/v1/home/servers", json={"servers": []}).status_code == 401
        assert client.put("/v1/home/servers", json={"servers": []}, headers={"Authorization": "Bearer k"}).status_code == 200


def test_engine_stop_stops_every_listener(database_url, schema):
    fake_a, fake_b = FakeHomeAssistant(), FakeHomeAssistant()
    engine, http = make_app(database_url, schema)
    with http as client:
        wait_for(lambda: engine.ready)
        put_servers(client, server(fake_a, "a", "A"), server(fake_b, "b", "B"))
        wait_for(lambda: len(engine.homes.listeners) == 2)
        threads = [listener._thread for listener in engine.homes.listeners.values()]
    assert all(not t.is_alive() for t in threads) and engine.homes.listeners == {}
