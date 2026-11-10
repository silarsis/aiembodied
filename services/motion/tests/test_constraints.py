"""Pure-numpy tests for constraints.py: paths, units, reveal filtering and root snapping."""

import math

import numpy as np
import pytest

from motion_service.constraints import (
    ConstraintPlan, PathParams, SnapTarget, TargetParams, build_plan, end_pose, from_model_units,
    hand_bundle, heading_of, path_length, scale_for, schedule_path, smooth_path, snap_root, snap_weights,
    to_model_units, window_frames,
)
from motion_service.retarget import SOMA77, SOMA_REST_HIPS_HEIGHT

FPS = 30.0


# --- paths -------------------------------------------------------------------------------------

def _turn_angles(p):
    d = np.diff(p, axis=0)
    a = np.arctan2(d[:, 1], d[:, 0])
    return np.abs((np.diff(a) + math.pi) % (2 * math.pi) - math.pi)


def test_smooth_path_keeps_ends_and_rounds_a_right_angle():
    raw = [(0, 0), (0, 3), (2, 3)]
    p = smooth_path(raw, 0.6)
    assert np.allclose(p[0], raw[0]) and np.allclose(p[-1], raw[-1])
    # the corner vertex is cut off: nothing on the path is at (0, 3), the arc starts 0.6 m before it
    assert np.linalg.norm(p - np.array([0, 3]), axis=1).min() > 0.15
    assert any(np.allclose(q, [0, 2.4]) for q in p) and any(np.allclose(q, [0.6, 3]) for q in p)
    # circular arc of radius 0.6 around (0.6, 2.4)
    arc = p[(p[:, 1] > 2.41) & (p[:, 0] < 0.59)]
    assert len(arc) > 5
    assert np.allclose(np.linalg.norm(arc - np.array([0.6, 2.4]), axis=1), 0.6, atol=1e-6)


def test_smooth_path_is_continuous_with_small_turns():
    p = smooth_path([(0, 0), (0, 3), (2, 3), (2, 0)], 0.6)
    steps = np.linalg.norm(np.diff(p, axis=0), axis=1)
    arc_steps = steps[steps < 0.1]  # arcs are sampled about every 5 cm; straights are single long steps
    assert len(arc_steps) == 2 * 19 and 0.02 < arc_steps.mean() < 0.06
    assert sorted(np.round(steps[steps >= 0.1], 6)) == [0.8, 2.4, 2.4]  # 3-0.6, 2-1.2, 3-0.6
    assert _turn_angles(p).max() < 0.5  # no sharp corner left (a raw polyline has 90 degree turns)
    assert path_length(p) < path_length([(0, 0), (0, 3), (2, 3), (2, 0)])


def test_smooth_path_clamps_radius_to_half_the_shorter_segment():
    p = smooth_path([(0, 0), (0, 1), (3, 1)], 5.0)  # shorter segment is 1 m: cut at most 0.5 m
    assert any(np.allclose(q, [0, 0.5]) for q in p) and any(np.allclose(q, [0.5, 1]) for q in p)
    assert np.allclose(p[0], [0, 0]) and np.allclose(p[-1], [3, 1])


def test_smooth_path_leaves_straight_and_degenerate_input_alone():
    assert np.allclose(smooth_path([(0, 0), (0, 1), (0, 2)]), [(0, 0), (0, 1), (0, 2)])
    assert np.allclose(smooth_path([(0, 0), (0, 0), (1, 0)]), [(0, 0), (1, 0)])
    assert np.allclose(smooth_path([(1, 1)]), [(1, 1)])
    rev = smooth_path([(0, 0), (0, 2), (0, 0)], 0.6)  # a 180 degree reversal keeps its vertex
    assert any(np.allclose(q, [0, 2]) for q in rev)
    assert np.allclose(smooth_path([(0, 0), (0, 3), (2, 3)], 0), [(0, 0), (0, 3), (2, 3)])


def test_schedule_path_dense_timing_at_speed():
    s = schedule_path([(0, 0), (0, 3)], speed=1.0, start_s=0.3, fps=FPS, mode="dense")
    frames = [f for f, _, _ in s]
    assert frames == list(range(9, 9 + 90 + 1 + 15))  # 3 s of walking, then a 0.5 s hold
    pos = {f: (x, z) for f, x, z in s}
    assert pos[9] == pytest.approx((0, 0)) and pos[9 + 30] == pytest.approx((0, 1.0))
    assert pos[99] == pytest.approx((0, 3.0)) and pos[114] == pytest.approx((0, 3.0))
    fast = schedule_path([(0, 0), (0, 3)], speed=2.0, start_s=0.0, fps=FPS)
    assert max(f for f, _, _ in fast) == 45 + 15 and dict((f, z) for f, _, z in fast)[30] == pytest.approx(2.0)


def test_schedule_path_waypoints_only_has_the_vertices_and_a_final_hold():
    s = schedule_path([(0, 0), (0, 3), (2, 3)], speed=1.0, start_s=0.5, fps=FPS, mode="waypoints")
    assert s == [(15 + 90, 0.0, 3.0), (15 + 150, 2.0, 3.0), (15 + 150 + 15, 2.0, 3.0)]
    with pytest.raises(ValueError):
        schedule_path([(0, 0), (1, 0)], 1.0, 0, FPS, "follow")


def test_schedule_path_single_point_just_holds():
    s = schedule_path([(1, 2)], 1.0, 0.0, FPS)
    assert [f for f, _, _ in s] == list(range(0, 16)) and all((x, z) == (1.0, 2.0) for _, x, z in s)


# --- units -------------------------------------------------------------------------------------

def test_unit_scaling_round_trips():
    assert scale_for(None) == 1.0
    rest = {"hips": [0, 0.8, 0]}
    scale = scale_for(rest)
    assert scale == pytest.approx(0.8 / SOMA_REST_HIPS_HEIGHT)
    assert to_model_units(0.8, scale) == pytest.approx(SOMA_REST_HIPS_HEIGHT)
    assert np.allclose(to_model_units([1.0, 2.0], scale) * scale, [1.0, 2.0])
    assert from_model_units(np.array([0.5]), 2.0)[0] == pytest.approx(1.0)
    assert to_model_units(1.0, 1.0) == 1.0


def test_plan_converts_request_metres_to_model_units():
    scale = 0.8
    plan = build_plan(None, [TargetParams(t=1.0, root=(0.8, 1.6), height=0.4, heading=1.0)], FPS, scale, 90)
    tg = plan.visible(0)
    assert tg.root2d[30] == pytest.approx((1.0, 2.0))
    assert tg.root_y[30] == pytest.approx(0.5) and tg.heading[30] == 1.0  # heading is an angle: unscaled
    assert plan.snaps[0].x == pytest.approx(1.0)


# --- plan, reveal ------------------------------------------------------------------------------

def test_reveal_filters_targets_by_chunk_start():
    plan = build_plan(
        PathParams([(0, 0), (0, 2)], start_s=0.0),
        [TargetParams(t=5.5, until=5.6, root=(0, 2.15), height=0.5, heading=3.0, reveal_s=4.0),
         TargetParams(t=2.0, heading=1.0)], FPS, 1.0, 240)
    for start in (0, 60):  # chunk starts 0 s, 2 s: the sit target (reveal 4 s) is hidden
        tg = plan.visible(start)
        assert 165 not in tg.root2d and 165 not in tg.root_y
        assert tg.heading[60] == 1.0
    tg = plan.visible(120)  # 4 s: revealed
    assert tg.root2d[165] == (0.0, 2.15) and tg.root_y[165] == 0.5 and tg.heading[165] == 3.0
    assert 168 in tg.root_y and 169 not in tg.root_y  # held t..until inclusive: 5.5 s .. 5.6 s
    assert plan.visible(120).max_frame(120) == 168
    assert plan.visible(0).max_frame(120) is None or plan.visible(0).max_frame(120) <= 66


def test_targets_override_path_on_the_same_frame_and_frames_are_clipped():
    plan = build_plan(PathParams([(0, 0), (0, 1)], start_s=0), [TargetParams(t=1.0, root=(5, 5))], FPS, 1.0, 40)
    tg = plan.visible(0)
    assert tg.root2d[30] == (5.0, 5.0)
    assert max(tg.root2d) == 39


def test_hand_target_expands_to_the_ee_bundle():
    plan = build_plan(None, [TargetParams(t=2.0, until=2.1, hand="right", position=(-0.18, 0.75, 0.5),
                                          root=(0, 0), height=0.9, heading=0.0)], FPS, 1.0, 120)
    tg = plan.visible(0)
    assert sorted(f for f in tg.root2d) == [60, 61, 62, 63]
    assert tg.joints[(60, "RightHand")] == pytest.approx((-0.18, 0.75, 0.5))
    assert tg.joints[(60, "RightHandMiddleEnd")] == pytest.approx((-0.18, 0.75, 0.68))
    assert np.allclose(tg.rots[(60, "RightHand")], [[0, 0, 1], [0, 1, 0], [-1, 0, 0]])  # steer_test ry90
    assert tg.root_y[60] == 0.9 and tg.heading[60] == 0.0
    with pytest.raises(ValueError):
        build_plan(None, [TargetParams(t=1, hand="left", position=(0, 1, 0.3))], FPS, 1.0, 60)


def test_left_hand_bundle_points_forward_palm_down():
    joints, rots = hand_bundle("left", (0.2, 0.8, 0.4), math.pi / 2)  # facing +X
    assert joints["LeftHandMiddleEnd"] == pytest.approx((0.2 + 0.18, 0.8, 0.4))
    R = rots["LeftHand"]
    assert np.allclose(R @ R.T, np.eye(3)) and np.isclose(np.linalg.det(R), 1)
    # the left arm (+X in the T-pose) now points along the heading, +X here
    assert np.allclose(R @ np.array([1.0, 0, 0]), [1.0, 0, 0], atol=1e-9)


def test_plan_empty_and_window_frames():
    assert ConstraintPlan().empty and build_plan(None, [], FPS).empty
    assert window_frames(60, 0, None, 160, 60, 4, 300) == 120
    assert window_frames(60, 0, 150, 160, 60, 4, 300) == 152
    assert window_frames(60, 0, 1000, 160, 60, 4, 300) == 280  # future context capped at 160 frames
    assert window_frames(240, 0, 1000, 160, 60, 4, 300) == 300  # whole-window cap
    assert window_frames(0, 0, 30, 160, 60, 4, 300) == 60


# --- snapping ----------------------------------------------------------------------------------

def _walk_root(frames, drift=0.04):
    """Walks 1 m/s along +Z and stops at z = 2 (plus a 4 cm error), swaying a little."""
    t = np.arange(frames)
    return np.stack([0.02 * np.sin(t / 9.0) + drift, np.full(frames, 0.97), np.minimum(t / 30.0, 2.0) + drift], axis=1)


def test_snap_lands_exactly_on_target_frames_and_blends_before():
    root = _walk_root(120)
    plan = ConstraintPlan(FPS, snaps=[SnapTarget(60, 70, 0.0, 2.0)])
    snapped, delta = snap_root(root, plan, FPS, 0.3)
    assert np.allclose(snapped[60:71, [0, 2]], [0.0, 2.0], atol=1e-12)
    assert np.allclose(snapped[:50], root[:50])  # untouched before the 9-frame window
    assert not np.allclose(snapped[55], root[55])
    assert np.allclose(snapped[:, 1], root[:, 1])  # height is never snapped
    assert np.allclose(snapped, root + delta)
    # continuous: no frame-to-frame jump much larger than the raw motion's
    raw_step = np.linalg.norm(np.diff(root[:, [0, 2]], axis=0), axis=1).max()
    snap_step = np.linalg.norm(np.diff(snapped[:, [0, 2]], axis=0), axis=1).max()
    assert snap_step < raw_step + 0.02


def test_snap_is_chunk_independent():
    root = _walk_root(120)
    plan = ConstraintPlan(FPS, snaps=[SnapTarget(55, 80, 0.1, 1.9)])
    whole, _ = snap_root(root, plan, FPS, 0.3)
    a, _ = snap_root(root[:60], plan, FPS, 0.3, 0)
    b, _ = snap_root(root[60:], plan, FPS, 0.3, 60)
    assert np.allclose(np.concatenate([a, b]), whole)


def test_snap_off_and_carry():
    root = _walk_root(30)
    plan = ConstraintPlan(FPS, snaps=[SnapTarget(10, 20, 0, 0)])
    out, delta = snap_root(root, plan, FPS, 0)
    assert np.array_equal(out, root) and not delta.any()
    out, _ = snap_root(root, None, FPS, 0.3, 0, carry=(0.05, -0.03))
    assert out[0, 0] - root[0, 0] == pytest.approx(0.05, abs=0.01) and out[0, 2] - root[0, 2] == pytest.approx(-0.03, abs=0.01)
    assert np.all(np.diff(out[:10, 0] - root[:10, 0]) < 0)  # fades monotonically
    assert np.allclose(out[10:], root[10:])  # gone after snap_s


def test_single_frame_targets_are_not_snapped_only_spans_are():
    root = _walk_root(120)
    waypoint = ConstraintPlan(FPS, snaps=[SnapTarget(60, 60, 0.3, 2.0)])
    out, delta = snap_root(root, waypoint, FPS, 0.3)
    assert np.array_equal(out, root) and not delta.any()
    hold = ConstraintPlan(FPS, snaps=[SnapTarget(60, 61, 0.3, 2.0)])
    assert np.allclose(snap_root(root, hold, FPS, 0.3)[0][60:62, [0, 2]], [0.3, 2.0])


def test_snap_weights_shape():
    w = snap_weights(np.arange(100), SnapTarget(50, 60, 0, 0), 9)
    assert w[50:61].tolist() == [1.0] * 11 and w[:41].sum() == 0 and w[70:].sum() == 0
    assert np.all(np.diff(w[41:51]) > 0) and np.all(np.diff(w[60:70]) < 0)


# --- headings and end pose ---------------------------------------------------------------------

def _joints_facing(theta):
    idx = {n: i for i, n in enumerate(SOMA77)}
    J = np.zeros((1, len(SOMA77), 3))
    c, s = math.cos(theta), math.sin(theta)
    right_local, left_local = np.array([-0.1, 0, 0]), np.array([0.1, 0, 0])
    rot = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    J[0, idx["RightLeg"]], J[0, idx["LeftLeg"]] = rot @ right_local, rot @ left_local
    return J, idx


@pytest.mark.parametrize("theta", [0.0, 1.0, math.pi / 2, -2.0, 3.0])
def test_heading_of_matches_facing_convention(theta):
    J, idx = _joints_facing(theta)
    assert heading_of(J, idx)[0] == pytest.approx(theta)
    facing = np.array([math.sin(theta), math.cos(theta)])
    assert facing @ np.array([math.sin(heading_of(J, idx)[0]), math.cos(heading_of(J, idx)[0])]) == pytest.approx(1)


def test_end_pose_is_scaled_and_relative_to_the_origin():
    J, idx = _joints_facing(1.0)
    J += np.array([1.0, 0.0, 2.0])
    J[0, idx["RightHand"]] = [0.5, 1.0, 2.5]
    root = np.array([[1.0, 0.9, 2.0]])
    pose = end_pose(root, J, SOMA77, (0.1, 0.2), 0.5)
    assert pose["root"] == pytest.approx([0.45, 0.9])
    assert pose["height"] == pytest.approx(0.45) and pose["heading"] == pytest.approx(1.0, abs=1e-4)
    assert pose["right_hand"] == pytest.approx([0.2, 0.5, 1.15]) and len(pose["left_hand"]) == 3
