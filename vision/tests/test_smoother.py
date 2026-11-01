from clarion_vision.chain import PeopleSmoother
from clarion_vision.sources.base import FloorPoint


def pt(x, z, track, camera="cam"):
    return FloorPoint(x=x, z=z, level="G", track=track, conf=0.9, box_h=100.0, camera=camera)


def test_stable_ids_smoothing_and_no_one_tick_ghosts():
    s = PeopleSmoother(alpha=0.5, min_seen=2, hold=2)
    assert s.update([pt(0, 0, 1), pt(5, 5, 2)], True) == []          # one tick: not drawn yet
    out = s.update([pt(1, 0, 1)], True)                               # track 2 missed once: held, but never shown
    assert [p["id"] for p in out] == ["cam:1"] and out[0]["x"] == 0.5  # EMA halfway
    out = s.update([pt(1, 0, 1)], True)
    assert out[0]["id"] == "cam:1" and out[0]["x"] == 0.75


def test_a_track_swap_between_cameras_keeps_the_id():
    s = PeopleSmoother(min_seen=1)
    s.update([pt(0, 0, 7, "a")], True)
    s.update([], True)                                                # missed: held
    out = s.update([pt(0.4, 0, 3, "b")], True)                        # another camera's track, same place
    assert [p["id"] for p in out] == ["a:7"]


def test_without_valid_tracks_points_pass_through():
    s = PeopleSmoother()
    assert s.update([pt(1.234, 2, 1)], False) == [{"x": 1.23, "z": 2, "level": "G"}]
