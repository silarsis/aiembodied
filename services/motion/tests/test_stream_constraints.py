"""/v1/motion/stream with paths, targets, phases and continue_from, against the fake backend."""

import json
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from motion_service.app import create_app
from motion_service.backends.fake import FakeBackend

from vrma_check import assert_valid_vrma

REST = {"hips": [0, 0.8, 0], "spine": [0, 0.9, 0], "chest": [0, 1.0, 0], "upperChest": [0, 1.1, 0]}
for _side, _sx in (("left", 0.2), ("right", -0.2)):
    REST.update(
        {
            f"{_side}Shoulder": [_sx / 2, 1.2, 0],
            f"{_side}UpperArm": [_sx, 1.2, 0],
            f"{_side}LowerArm": [_sx * 2, 1.2, 0],
            f"{_side}Hand": [_sx * 3, 1.2, 0],
        }
    )


@pytest.fixture
def backend():
    return FakeBackend()


@pytest.fixture
def client(backend):
    with TestClient(create_app(backend, load_in_background=False)) as c:
        yield c


def lines(r):
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def chunks_of(r):
    out = lines(r)
    assert out[-1]["type"] == "done", out[-1]
    return out[:-1], out[-1]


def test_plain_request_is_unchanged_but_has_end_pose_and_session(client, backend):
    chunks, done = chunks_of(client.post("/v1/motion/stream", json={"prompt": "wave", "duration": 4}))
    assert len(chunks) == 2 and backend.calls[0]["plan"] is None
    assert set(chunks[0]["end_pose"]) == {"root", "height", "heading", "left_hand", "right_hand"}
    assert chunks[0]["end_pose"]["height"] == pytest.approx(0.99, abs=0.01)
    assert done["session"].startswith("s-")


def test_path_walks_to_the_end_point_in_avatar_units(client):
    body = {
        "prompt": "a person walks calmly",
        "duration": 6,
        "avatar_rest": REST,
        "path": {"points": [[0, 0], [0, 1.6]], "speed": 0.8, "start_s": 0.0},
    }
    chunks, _ = chunks_of(client.post("/v1/motion/stream", json=body))
    ends = [c["end_pose"]["root"] for c in chunks]
    assert ends[0][1] < ends[1][1] <= 1.6 + 1e-3  # walking
    assert ends[-1] == pytest.approx([0.0, 1.6], abs=0.02)  # avatar metres out
    # the hips track is in rest-hips-height units: z / 0.989, with the avatar's scale divided out
    hips = chunks[-1]["vrma"]["hips"]["position"]["keyframes"][-1]["p"]
    scale = 0.8 / 0.989
    assert hips[2] == pytest.approx(1.6 / scale / 0.989, abs=0.02)


def test_root_target_is_snapped_exactly(client):
    body = {"prompt": "x", "duration": 4, "targets": [{"t": 3.0, "until": 3.5, "root": [0.4, 1.2]}]}
    chunks, _ = chunks_of(client.post("/v1/motion/stream", json=body))
    # frame 105 is in chunk 1 (frames 60..119), local index 45
    hips = chunks[1]["vrma"]["hips"]["position"]["keyframes"]
    for i in range(90 - 60, 105 - 60 + 1):
        assert hips[i]["p"][0] * 0.989 == pytest.approx(0.4, abs=1e-3)
        assert hips[i]["p"][2] * 0.989 == pytest.approx(1.2, abs=1e-3)


def test_snap_corrects_a_drifting_backend_and_can_be_turned_off():
    class Drifting(FakeBackend):  # the real model lands a few cm off its targets
        def _track(self, m, state, tg, start, fresh=False):
            out = super()._track(m, state, tg, start, fresh)
            ramp = np.arange(start, start + out.frames) / 100.0  # grows with time: 0 at the origin
            return out.translated(np.stack([0.05 * ramp, 0 * ramp, -0.04 * ramp], axis=1))

    base = {"prompt": "x", "duration": 4, "targets": [{"t": 3.0, "until": 4.0, "root": [0.4, 1.2]}]}
    got = {}
    for snap in (0.3, 0):
        with TestClient(create_app(Drifting(), load_in_background=False)) as c:
            chunks, _ = chunks_of(c.post("/v1/motion/stream", json={**base, "snap_s": snap}))
            got[snap] = chunks[1]["end_pose"]["root"]
    assert got[0.3] == pytest.approx([0.4, 1.2], abs=1e-3)
    assert got[0] != pytest.approx([0.4, 1.2], abs=0.01)


def test_height_and_heading_targets_reach_end_pose(client):
    body = {
        "prompt": "sit",
        "duration": 4,
        "targets": [{"t": 2.0, "until": 4.0, "root": [0, 1], "height": 0.5, "heading": 3.0}],
    }
    chunks, _ = chunks_of(client.post("/v1/motion/stream", json=body))
    pose = chunks[-1]["end_pose"]
    assert pose["height"] == pytest.approx(0.5, abs=0.01)
    assert pose["heading"] == pytest.approx(3.0, abs=0.01)


def test_phases_switch_prompts_at_chunk_boundaries(client, backend):
    body = {
        "prompt": "walk",
        "duration": 8,
        "phases": [{"prompt": "sit down", "start_s": 3.0}, {"prompt": "stand up", "start_s": 6.0}],
    }
    chunks_of(client.post("/v1/motion/stream", json=body))
    call = backend.calls[0]
    assert [f for f, _ in call["phase_texts"]] == [90, 180]
    # chunks start at 0, 2, 4, 6 s: a phase applies from the first chunk at or after its start
    assert call["texts"] == ["walk", "walk", "sit down", "stand up"]


def test_reveal_s_hides_targets_from_early_chunks(client, backend):
    body = {
        "prompt": "x",
        "duration": 6,
        "path": {"points": [[0, 0], [0, 1]], "start_s": 0},
        "targets": [{"t": 5.0, "root": [0, 2], "height": 0.5, "reveal_s": 4.0}],
    }
    chunks_of(client.post("/v1/motion/stream", json=body))
    vis = backend.calls[0]["visible"]
    assert 150 not in vis[0].root2d and 150 not in vis[60].root2d and 150 in vis[120].root2d


def test_continue_from_keeps_the_frame_and_the_hips_origin(client, backend):
    first = chunks_of(
        client.post(
            "/v1/motion/stream",
            json={"prompt": "walk", "duration": 4, "path": {"points": [[0, 0], [0, 2]], "start_s": 0}},
        )
    )
    sid = first[1]["session"]
    end_z = first[0][-1]["end_pose"]["root"][1]
    second, done2 = chunks_of(
        client.post(
            "/v1/motion/stream",
            json={
                "prompt": "stand",
                "duration": 2,
                "continue_from": sid,
                "targets": [{"t": 1.0, "until": 2.0, "root": [0.5, 2.0], "height": 0.6, "heading": 1.0}],
            },
        )
    )
    assert backend.calls[1]["history"] is not None
    # continues from where the first ended and shares its origin: no reset to zero
    hips_z = second[0]["vrma"]["hips"]["position"]["keyframes"][0]["p"][2] * 0.989
    assert hips_z == pytest.approx(end_z, abs=0.1)
    assert second[0]["start"] == 0.0
    assert second[-1]["end_pose"]["root"] == pytest.approx([0.5, 2.0], abs=1e-3)
    assert second[-1]["end_pose"]["height"] == pytest.approx(0.6, abs=0.01)
    assert done2["session"] != sid
    # the new session continues too
    third, _ = chunks_of(
        client.post("/v1/motion/stream", json={"prompt": "x", "duration": 1, "continue_from": done2["session"]})
    )
    assert len(third) == 1


def test_unknown_session_is_404(client):
    r = client.post("/v1/motion/stream", json={"prompt": "x", "continue_from": "s-nope"})
    assert r.status_code == 404 and r.json() == {"error": "unknown session"}


def test_sessions_expire_and_only_the_last_eight_are_kept(backend):
    with TestClient(create_app(backend, load_in_background=False, session_ttl_seconds=0.05)) as c:
        sid = chunks_of(c.post("/v1/motion/stream", json={"prompt": "x", "duration": 1}))[1]["session"]
        import time

        time.sleep(0.1)
        assert c.post("/v1/motion/stream", json={"prompt": "x", "continue_from": sid}).status_code == 404
    with TestClient(create_app(FakeBackend(), load_in_background=False)) as c:
        ids = [
            chunks_of(c.post("/v1/motion/stream", json={"prompt": "x", "duration": 1}))[1]["session"] for _ in range(10)
        ]
        gone = [
            c.post("/v1/motion/stream", json={"prompt": "x", "duration": 1, "continue_from": i}).status_code
            for i in ids[:2]
        ]
        kept = [
            c.post("/v1/motion/stream", json={"prompt": "x", "duration": 1, "continue_from": i}).status_code
            for i in ids[-6:-2]
        ]
        assert gone == [404, 404] and kept == [200] * 4


def test_constraint_weight_reaches_the_backend(client, backend):
    chunks_of(client.post("/v1/motion/stream", json={"prompt": "x", "duration": 1, "constraint_weight": 1.0}))
    chunks_of(client.post("/v1/motion/stream", json={"prompt": "x", "duration": 1}))
    assert [c["constraint_weight"] for c in backend.calls] == [1.0, 2.0]


def test_chunk_vrma_is_valid_with_constraints(client):
    body = {"prompt": "x", "duration": 3, "path": {"points": [[0, 0], [1, 1], [2, 0]], "mode": "waypoints"}}
    for c in chunks_of(client.post("/v1/motion/stream", json=body))[0]:
        assert_valid_vrma(c["vrma"])


HAND = {"t": 1.0, "hand": "right", "position": [-0.18, 0.75, 0.5], "root": [0, 0], "height": 0.9, "heading": 0}


@pytest.mark.parametrize(
    "patch",
    [
        {"path": {"points": []}},
        {"path": {"points": [[0, 0, 0]]}},
        {"path": {"points": [[0, "x"]]}},
        {"path": {"points": [[0, 0]], "mode": "follow"}},
        {"path": {"points": [[0, 0]], "speed": 0}},
        {"path": {"points": [[0, 0]], "corner_radius": -1}},
        {"path": {"points": [[0, 1e9]]}},
        {"targets": [{**HAND, "hand": "middle"}]},
        {"targets": [{**HAND, "position": None}]},
        {"targets": [{**HAND, "root": None}]},
        {"targets": [{**HAND, "height": None}]},
        {"targets": [{**HAND, "heading": None}]},
        {"targets": [{"t": 1.0}]},
        {"targets": [{"t": 1.0, "heading": 0, "position": [0, 0, 0]}]},
        {"targets": [{"t": 2.0, "until": 1.0, "root": [0, 0]}]},
        {"targets": [{"t": -1.0, "root": [0, 0]}]},
        {"targets": [{"t": "NaN", "root": [0, 0]}]},
        {"targets": [{"t": 1.0, "root": [0, 0], "height": 0}]},
        {"targets": [{"t": 1.0, "root": [0, 0], "heading": 1e999}]},
        {"phases": [{"prompt": "  ", "start_s": 1}]},
        {"phases": [{"prompt": "x", "start_s": -1}]},
        {"constraint_weight": -1},
        {"snap_s": -0.1},
        {"duration": 31},
    ],
)
def test_invalid_constraint_fields_are_400(client, patch):
    r = client.post(
        "/v1/motion/stream", content=json.dumps({"prompt": "x", **patch}), headers={"content-type": "application/json"}
    )
    assert r.status_code == 400 and r.json()["error"]


def test_valid_full_request_is_accepted(client):
    body = {
        "prompt": "a person walks calmly",
        "duration": 6.0,
        "avatar_rest": REST,
        "phases": [{"prompt": "a person turns around and sits down on a chair", "start_s": 4.0}],
        "path": {
            "points": [[0, 0], [0, 2.5], [1.2, 3.0]],
            "corner_radius": 0.6,
            "speed": 1.0,
            "start_s": 0.3,
            "mode": "dense",
        },
        "targets": [
            {"t": 5.5, "until": 5.9, "root": [0.0, 2.65], "height": 0.5, "heading": math.pi, "reveal_s": 4.0},
            HAND,
        ],
        "constraint_weight": 2.0,
        "snap_s": 0.3,
    }
    r = client.post("/v1/motion/stream", json=body)
    assert r.status_code == 200 and lines(r)[-1]["type"] == "done"


def test_clip_endpoint_ignores_none_of_the_stream_fields_but_stays_10s(client):
    assert client.post("/v1/motion/clip", json={"prompt": "x", "duration": 11}).status_code == 400


def test_continue_after_a_cut_short_stream_does_not_rewind(client):
    # 46 frames: the stream keeps 44 (whole 4-frame groups), so the continuation restarts 2 frames back.
    first = chunks_of(
        client.post(
            "/v1/motion/stream",
            json={
                "prompt": "walk",
                "duration": 46 / 30,
                "path": {"points": [[0, 0], [0, 6]], "speed": 1.0, "start_s": 0.0},
            },
        )
    )
    end_z = first[0][-1]["end_pose"]["root"][1]
    assert end_z == pytest.approx(45 / 30, abs=1e-3)
    # the continuation walks on the same line: its frame 0 is the stream's frame 44
    second, _ = chunks_of(
        client.post(
            "/v1/motion/stream",
            json={
                "prompt": "walk",
                "duration": 3.0,
                "continue_from": first[1]["session"],
                "path": {"points": [[0, 44 / 30], [0, 8]], "speed": 1.0, "start_s": 0.0},
            },
        )
    )
    hips = second[0]["vrma"]["hips"]["position"]["keyframes"]
    assert hips[0]["t"] == 0.0
    # the first frame played is the one after the last frame already played, not two frames before it
    assert hips[0]["p"][2] * 0.989 == pytest.approx(end_z + 1 / 30, abs=1e-3)
    assert len(hips) == 60 - 2
    assert second[1]["start"] == pytest.approx(58 / 30, abs=1e-4)
    assert hips[1]["p"][2] > hips[0]["p"][2]


def test_continue_after_a_whole_chunk_drops_nothing(client):
    first = chunks_of(client.post("/v1/motion/stream", json={"prompt": "walk", "duration": 2.0}))
    second, _ = chunks_of(
        client.post("/v1/motion/stream", json={"prompt": "walk", "duration": 2.0, "continue_from": first[1]["session"]})
    )
    assert len(second[0]["vrma"]["hips"]["position"]["keyframes"]) == 60 and second[0]["start"] == 0.0


# ---- joint targets and the observed pose ----------------------------------------------------------


def _visible_at(backend, start=0):
    return backend.calls[-1]["visible"][start]


def test_joint_target_maps_to_soma_names_and_scales_to_model_units(client, backend):
    body = {
        "prompt": "sit",
        "duration": 2,
        "avatar_rest": REST,
        "targets": [
            {"t": 1.0, "until": 1.5, "root": [0, 0.5], "height": 0.4},
            {"t": 1.0, "until": 1.5, "joint": "left_knee", "position": [0.1, 0.5, 0.6]},
            {"t": 1.6, "joint": "right_ankle", "position": [-0.1, 0.1, 0.7]},
        ],
    }
    assert client.post("/v1/motion/stream", json=body).status_code == 200
    tg = _visible_at(backend)
    scale = 0.8 / 0.989
    assert tg.joints[(30, "LeftShin")] == pytest.approx((0.1 / scale, 0.5 / scale, 0.6 / scale))
    assert tg.joints[(45, "LeftShin")] == pytest.approx((0.1 / scale, 0.5 / scale, 0.6 / scale))
    assert (46, "LeftShin") not in tg.joints
    # no pelvis root on frame 48: ARDY would reject a lone joint position, so the plan drops it
    assert not any(k[1] == "RightFoot" for k in tg.joints)


def test_joint_target_with_its_own_root_is_kept(client, backend):
    body = {
        "prompt": "sit",
        "duration": 2,
        "targets": [{"t": 1.0, "joint": "right_knee", "position": [-0.1, 0.5, 0.6], "root": [0, 0.5]}],
    }
    assert client.post("/v1/motion/stream", json=body).status_code == 200
    assert (30, "RightShin") in _visible_at(backend).joints


@pytest.mark.parametrize(
    "target",
    [
        {"t": 1, "joint": "left_elbow", "position": [0, 0, 0]},
        {"t": 1, "joint": "left_knee"},
        {"t": 1, "joint": "left_knee", "position": [0, 0, float("nan")]},
        {"t": 1, "joint": "left_knee", "position": [0, 0, 1e9]},
        {
            "t": 1,
            "joint": "left_knee",
            "position": [0, 0, 0],
            "hand": "left",
            "root": [0, 0],
            "height": 1,
            "heading": 0,
        },
    ],
)
def test_bad_joint_targets_are_400(client, target):
    r = client.post(
        "/v1/motion/stream",
        content=json.dumps({"prompt": "x", "targets": [target]}),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 400 and "error" in r.json()


def _session(client):
    _, done = chunks_of(client.post("/v1/motion/stream", json={"prompt": "walk", "duration": 2}))
    return done["session"]


def test_observed_pins_the_first_frames_of_a_continuation(client, backend):
    sid = _session(client)
    body = {
        "prompt": "sit",
        "duration": 2,
        "avatar_rest": REST,
        "continue_from": sid,
        "observed": {
            "joints": {"left_knee": [0.1, 0.5, 0.3], "right_ankle": [-0.1, 0.05, 0.4]},
            "root": [0.0, 0.2],
            "height": 0.6,
        },
    }
    assert client.post("/v1/motion/stream", json=body).status_code == 200
    tg = _visible_at(backend)
    scale = 0.8 / 0.989
    for f in range(4):
        assert tg.root2d[f] == pytest.approx((0.0, 0.2 / scale))
        assert tg.root_y[f] == pytest.approx(0.6 / scale)
        assert tg.joints[(f, "LeftShin")] == pytest.approx((0.1 / scale, 0.5 / scale, 0.3 / scale))
        assert tg.joints[(f, "RightFoot")] == pytest.approx((-0.1 / scale, 0.05 / scale, 0.4 / scale))
    assert 4 not in tg.root2d


def test_observed_beats_an_explicit_target_on_the_same_frames(client, backend):
    sid = _session(client)
    body = {
        "prompt": "x",
        "duration": 2,
        "continue_from": sid,
        "observed": {"root": [0.5, 0.5]},
        "targets": [{"t": 0, "until": 10 / 30, "root": [0, 0]}],
    }
    assert client.post("/v1/motion/stream", json=body).status_code == 200
    tg = _visible_at(backend)
    assert tg.root2d[2] == pytest.approx((0.5, 0.5)) and tg.root2d[6] == pytest.approx((0, 0))


@pytest.mark.parametrize(
    "observed",
    [
        {},
        {"joints": {"left_elbow": [0, 0, 0]}},
        {"joints": {"left_knee": [0, 0]}},
        {"root": [0, float("inf")]},
        {"height": -1},
    ],
)
def test_bad_observed_is_400(client, observed):
    sid = _session(client)
    r = client.post(
        "/v1/motion/stream",
        content=json.dumps({"prompt": "x", "continue_from": sid, "observed": observed}).replace("Infinity", "1e999"),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 400


def test_observed_without_continue_from_is_400(client):
    r = client.post("/v1/motion/stream", json={"prompt": "x", "observed": {"root": [0, 0]}})
    assert r.status_code == 400 and "continue_from" in r.json()["error"]
