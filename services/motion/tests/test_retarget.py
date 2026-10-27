import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from motion_service.backends.fake import HIPS_HEIGHT, synthetic_motion
from motion_service.retarget import SOMA_REST_HIPS_HEIGHT, RootFrame, SOMA77, slugify, to_vrma

from vrma_check import assert_valid_vrma


def _track(vrma, bone):
    return np.array([kf["q"] for kf in next(t for t in vrma["tracks"] if t["bone"] == bone)["keyframes"]])


def test_output_matches_app_schema():
    m = synthetic_motion(30)
    v = to_vrma(m.global_rot_mats, m.posed_joints, m.root_positions, "wave-hello", kind="fake")
    assert_valid_vrma(v)
    assert v["meta"] == {"name": "wave-hello", "fps": 30.0, "loop": False, "duration": pytest.approx(29 / 30, abs=1e-5), "kind": "fake"}
    bones = {t["bone"] for t in v["tracks"]}
    assert {"hips", "spine", "chest", "upperChest", "neck", "head", "rightUpperArm", "leftToes"} <= bones
    assert "rightIndexProximal" in bones and "leftThumbMetacarpal" in bones  # fingers for somaskel77
    assert len(v["tracks"]) == 22 + 30
    assert v["tracks"][0]["keyframes"][1]["t"] == pytest.approx(1 / 30, abs=1e-5)


def test_rest_pose_is_identity_and_arm_rotations_are_local():
    m = synthetic_motion(45)
    v = to_vrma(m.global_rot_mats, m.posed_joints, m.root_positions, "x")
    for bone in ("hips", "spine", "head", "leftUpperArm", "leftUpperLeg"):
        np.testing.assert_allclose(np.abs(_track(v, bone)[:, 3]), 1.0, atol=1e-6)
    upper = Rotation.from_quat(_track(v, "rightUpperArm"))
    np.testing.assert_allclose(upper.as_euler("xyz", degrees=True)[:, 2], -80, atol=1e-3)
    # lower arm is local to the upper arm: only the wave remains
    lower = Rotation.from_quat(_track(v, "rightLowerArm")).as_euler("xyz", degrees=True)[:, 2]
    t = np.arange(45) / 30
    np.testing.assert_allclose(lower, 25 * np.sin(2 * np.pi * 1.5 * t), atol=1e-3)
    # hand moves with the forearm -> identity local rotation
    np.testing.assert_allclose(np.abs(_track(v, "rightHand")[:, 3]), 1.0, atol=1e-6)


def test_hips_translation_in_rest_height_units_from_origin():
    m = synthetic_motion(60)
    v = to_vrma(m.global_rot_mats, m.posed_joints, m.root_positions, "x")
    p = np.array([kf["p"] for kf in v["hips"]["position"]["keyframes"]])
    np.testing.assert_allclose(p[:, 1], HIPS_HEIGHT / SOMA_REST_HIPS_HEIGHT, atol=1e-4)  # floor at toe height 0
    assert p[0, 0] == pytest.approx(0) and p[0, 2] == pytest.approx(0)
    np.testing.assert_allclose(p[:, 0], m.root_positions[:, 0] / SOMA_REST_HIPS_HEIGHT, atol=1e-4)


def test_shared_root_frame_keeps_chunks_continuous():
    full = synthetic_motion(120)
    names = SOMA77
    rf = RootFrame.from_motion(full.posed_joints, full.root_positions, names)
    a, b = full.slice(0, 60), full.slice(60, 120)
    va = to_vrma(a.global_rot_mats, a.posed_joints, a.root_positions, "c-0", root_frame=rf)
    vb = to_vrma(b.global_rot_mats, b.posed_joints, b.root_positions, "c-1", root_frame=rf)
    vf = to_vrma(full.global_rot_mats, full.posed_joints, full.root_positions, "c")
    pa = va["hips"]["position"]["keyframes"]
    pb = vb["hips"]["position"]["keyframes"]
    pf = vf["hips"]["position"]["keyframes"]
    assert pb[0]["t"] == 0  # each chunk restarts at t=0
    assert pb[0]["p"] == pytest.approx(pf[60]["p"], abs=1e-5)
    assert pa[-1]["p"] == pytest.approx(pf[59]["p"], abs=1e-5)


def test_quaternion_sign_continuity():
    m = synthetic_motion(10)
    G = m.global_rot_mats.copy()
    # a full 340-degree sweep about Y would flip quaternion hemispheres without the continuity fix
    G[:, 0] = Rotation.from_euler("y", np.linspace(0, 340, 10)[:, None], degrees=True).as_matrix()
    v = to_vrma(G, m.posed_joints, m.root_positions, "x")
    q = _track(v, "hips")
    assert (np.einsum("ij,ij->i", q[1:], q[:-1]) > 0).all()


def test_soma30_input_is_supported_without_fingers():
    m = synthetic_motion(5)
    keep = [SOMA77.index(n) for n in __import__("motion_service.retarget", fromlist=["SOMA30"]).SOMA30]
    v = to_vrma(m.global_rot_mats[:, keep], m.posed_joints[:, keep], m.root_positions, "x")
    assert len(v["tracks"]) == 22
    assert_valid_vrma(v)


def test_slugify():
    assert slugify("A person waves hello, with their RIGHT hand!") == "a-person-waves-hello-with-their-right-ha"
    assert slugify("!!!") == "motion"
    assert len(slugify("x" * 100)) == 40
