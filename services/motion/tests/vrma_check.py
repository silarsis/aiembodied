"""Python mirror of the app's vrmaSchema (app/main/src/avatar/vrma-schema.ts) for tests."""

import re

SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def assert_valid_vrma(v: dict) -> None:
    assert set(v) == {"meta", "tracks", "hips", "expressions"}
    meta = v["meta"]
    assert SLUG.match(meta["name"]), meta["name"]
    assert meta["fps"] > 0 and isinstance(meta["loop"], bool) and meta["duration"] >= 0 and meta["kind"]
    assert len(v["tracks"]) >= 1
    for track in v["tracks"]:
        assert track["bone"] and len(track["keyframes"]) >= 1
        for kf in track["keyframes"]:
            assert kf["t"] >= 0 and len(kf["q"]) == 4
            assert abs(sum(c * c for c in kf["q"]) - 1) < 1e-4
    assert set(v["hips"]) <= {"position"}
    for kf in v["hips"].get("position", {}).get("keyframes", []):
        assert kf["t"] >= 0 and len(kf["p"]) == 3
    assert isinstance(v["expressions"], list)
