import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from scipy.spatial.transform import Rotation

from motion_service.app import create_app
from motion_service.backends.fake import FakeBackend
from motion_service.calibration import (
    DEFAULT_ARM_FORWARD_BIAS_DEG,
    arm_forward_for_avatar,
    calibrated_arm_forward,
    hand_gap,
)

SKELETONS = json.loads((Path(__file__).parent / "rest_skeletons.json").read_text())


def test_soma_own_skeleton_needs_no_swing():
    # ARDY's reference pose on SOMA's own bones puts the hands exactly where ARDY's are.
    assert calibrated_arm_forward(SKELETONS["soma"], chest_forward=0) == pytest.approx(0, abs=0.05)


def test_bundled_avatar_needs_about_four_degrees():
    # Its shoulders sit ~2.5 cm further back on the chest, leaving the hands 3-4 cm behind ARDY's.
    gap = hand_gap(SKELETONS["bundled_avatar"], chest_forward=7)
    assert 0.025 < gap["left"] < 0.05 and 0.025 < gap["right"] < 0.05
    assert gap["arm_length"] == pytest.approx(0.48, abs=0.01)
    assert calibrated_arm_forward(SKELETONS["bundled_avatar"], chest_forward=7) == pytest.approx(4.25, abs=0.3)


def test_shoulders_further_back_need_more_swing():
    rest = {bone: list(p) for bone, p in SKELETONS["bundled_avatar"].items()}
    base = calibrated_arm_forward(rest, chest_forward=7)
    for bone in ("leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
                 "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand"):
        rest[bone][2] -= 0.02
    assert calibrated_arm_forward(rest, chest_forward=7) > base + 2


def test_bias_is_added_and_overridable(monkeypatch):
    monkeypatch.delenv("MOTION_ARM_FORWARD_BIAS_DEG", raising=False)
    rest = SKELETONS["bundled_avatar"]
    calibrated = calibrated_arm_forward(rest, chest_forward=7)
    assert arm_forward_for_avatar(rest, 7) == pytest.approx(calibrated + DEFAULT_ARM_FORWARD_BIAS_DEG, abs=1e-3)
    monkeypatch.setenv("MOTION_ARM_FORWARD_BIAS_DEG", "0")
    assert arm_forward_for_avatar(rest, 7) == pytest.approx(calibrated, abs=1e-3)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("MOTION_ARM_FORWARD_DEG", raising=False)
    with TestClient(create_app(FakeBackend(), load_in_background=False)) as c:
        yield c


def _upper_arm(client, **extra):
    body = client.post("/v1/motion/clip", json={"prompt": "stand still", "duration": 1.0, **extra}).json()
    track = next(t for t in body["vrma"]["tracks"] if t["bone"] == "leftShoulder")
    return Rotation.from_quat(track["keyframes"][0]["q"])


def test_requests_with_a_skeleton_use_its_calibration(client, monkeypatch):
    soma = _upper_arm(client, avatar_rest=SKELETONS["soma"])
    default = _upper_arm(client)
    bundled = _upper_arm(client, avatar_rest=SKELETONS["bundled_avatar"])
    # Without a skeleton the default 6 degrees applies; SOMA's skeleton calibrates to -2.8 (the chest
    # lean already brings its shoulders forward) plus the 1.5 bias; the bundled avatar to ~5.75.
    assert np.degrees((default * bundled.inv()).magnitude()) == pytest.approx(0.25, abs=0.3)
    assert np.degrees((default * soma.inv()).magnitude()) == pytest.approx(6 - (-2.85 + 1.5), abs=0.3)
    # MOTION_ARM_FORWARD_DEG is a manual override and wins over the skeleton.
    monkeypatch.setenv("MOTION_ARM_FORWARD_DEG", "6")
    overridden = _upper_arm(client, avatar_rest=SKELETONS["soma"])
    assert np.degrees((default * overridden.inv()).magnitude()) == pytest.approx(0, abs=1e-3)


@pytest.mark.parametrize("rest", [
    {"hips": [0, 0.9, 0]},
    {**SKELETONS["bundled_avatar"], "leftHand": [0, 1]},
    {**SKELETONS["bundled_avatar"], "hips": [0, -0.1, 0]},
])
def test_malformed_skeletons_are_400(client, rest):
    r = client.post("/v1/motion/clip", json={"prompt": "wave", "avatar_rest": rest})
    assert r.status_code == 400 and "avatar_rest" in r.json()["error"]
