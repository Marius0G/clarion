"""The camera channel's schema (CctvLive.cs), and the labelled export's real calib.json when it exists."""
import json
from pathlib import Path

import numpy as np
import pytest

from clarion_vision.config import UNITY_REPO
from clarion_vision.geometry import Calib, in_ring, ring_samples
from clarion_vision.queues import load_queues
from clarion_vision.sources.base import load_camera_specs
from clarion_vision.sources.live_files import JsonlReplaySource, LiveFilesSource, read_json
from clarion_vision.sources.synthetic import SyntheticAirport
from clarion_vision.terminal import load_terminal
from tools.fake_cctv_live import Channel, floor_homography, pose


def calib_doc(level="U", scale=0.01):
    # image u,v (pixels) -> floor x = 6280 + u*scale, z = -500 + v*scale
    H = [[scale, 0, 6280.0], [0, scale, -500.0], [0, 0, 1.0]]
    return {"K": [[800, 0, 640], [0, 800, 360], [0, 0, 1]], "dist_opencv": [0, 0, 0, 0], "level": level, "floors": {level: {"H_image_to_floor": H}}}


def live_dir(tmp_path: Path) -> Path:
    cam = {"id": "cctv_a", "level": "U", "view_region": [[6280, -500], [6300, -500], [6300, -480], [6280, -480]], "queues_seen": [{"queue": "security", "coverage": 0.9}]}
    (tmp_path / "manifest.json").write_text(json.dumps({"schema": 1, "seed": 1, "det_hz": 2, "frame_fps": 1, "cameras": ["cctv_a"], "frame_cameras": ["cctv_a"], "truth": False, "detector": "simulated"}))
    (tmp_path / "cctv.json").write_text(json.dumps({"cameras": [cam], "queues": []}))
    (tmp_path / "cctv_a").mkdir()
    (tmp_path / "cctv_a" / "calib.json").write_text(json.dumps(calib_doc()))
    return tmp_path


def detections(seq, boxes):
    return {"seq": seq, "seed": 1, "t_s": 25200.0 + seq, "speed": 10.0, "tracks_valid": True, "detector": "simulated", "cameras": {"cctv_a": {"boxes": boxes}}}


def test_box_to_floor_uses_the_foot_point():
    pts = Calib(calib_doc()).feet_to_floor(np.array([[100.0, 50.0, 20.0, 80.0]]))
    assert pts[0] == pytest.approx([6280 + 110 * 0.01, -500 + 130 * 0.01])


def test_live_source_reads_ticks_once_and_keeps_the_label(tmp_path):
    root = live_dir(tmp_path)
    src = LiveFilesSource(root)
    assert src.detector == "simulated" and [s.id for s in src.camera_specs()] == ["cctv_a"]
    assert src.read(None) is None
    (root / "detections.json").write_text(json.dumps(detections(1, [[100, 50, 20, 80, 0.9, 7]])))
    tick = src.read(None)
    assert tick.detector == "simulated" and tick.t_s == 25201.0 and tick.speed == 10.0
    p = tick.cameras["cctv_a"][0]
    assert p.track == 7 and p.level == "U" and p.box_h == 80 and p.x == pytest.approx(6281.1)
    assert src.read(None) is None              # same seq


def test_an_empty_picture_is_not_a_camera_down(tmp_path):
    root = live_dir(tmp_path)
    src = LiveFilesSource(root)
    (root / "detections.json").write_text(json.dumps(detections(2, [])))
    assert src.read(None).cameras == {"cctv_a": []}
    row = detections(3, [])
    row["cameras"] = {}
    (root / "detections.json").write_text(json.dumps(row))
    assert src.read(None).cameras == {}


def test_missing_manifest_says_so(tmp_path):
    with pytest.raises(FileNotFoundError):
        LiveFilesSource(tmp_path)


def test_half_written_file_is_retried_not_fatal(tmp_path):
    f = tmp_path / "x.json"
    f.write_text("{bad")
    assert read_json(f, retries=2, wait_s=0.0) is None


def test_jsonl_replay_same_schema(tmp_path):
    root = live_dir(tmp_path)
    log = tmp_path / "det.jsonl"
    log.write_text("\n".join(json.dumps(detections(i, [[1, 2, 3, 4, 0.5, i]])) for i in range(3)) + "\n")
    src = JsonlReplaySource(log, root, json.loads((root / "cctv.json").read_text()))
    ticks = []
    while (t := src.read()) is not None:
        ticks.append(t)
    src.close()
    assert [t.seq for t in ticks] == [0, 1, 2]


def test_ring_helpers():
    ring = np.array([[0, 0], [2, 0], [2, 2], [0, 2]], float)
    assert in_ring(np.array([1.0, 3.0]), np.array([1.0, 1.0]), ring).tolist() == [True, False]
    xs, _ = ring_samples(ring, 0.5)
    assert xs.size >= 9


def test_the_whole_channel_round_trip_returns_the_same_floor_points(tmp_path):
    """Synthetic people -> boxes through each camera's real pose -> the channel's files -> LiveFilesSource -> the same floor points."""
    terminal = load_terminal()
    specs, queues = load_camera_specs(), load_queues(lane_limits=terminal.lane_limits)
    air = SyntheticAirport(queues, specs, terminal, seed=2, start_s=8.5 * 3600, recall=1.0)
    channel = Channel(tmp_path)
    source = LiveFilesSource(tmp_path)
    assert source.detector == "synthetic" and source.camera_specs()
    for _ in range(40):
        tick = air.step(5.0)
    channel.write_tick(tick, 10.0)
    got = source.read(None)
    assert got is not None and got.t_s == pytest.approx(tick.t_s, abs=1e-3) and set(got.cameras) == set(tick.cameras)
    matched = 0
    for camera, points in got.cameras.items():
        originals = {p.track: p for p in tick.cameras[camera]}
        for p in points:
            q = originals[p.track]
            assert (p.x - q.x) ** 2 + (p.z - q.z) ** 2 < 0.05 ** 2
            matched += 1
    assert matched > 20


REAL = UNITY_REPO / "data/interim/cctv/cctv_103143_s1_20261031_153004_selftest/cctv_security_queue/calib.json"


@pytest.mark.skipif(not REAL.exists(), reason="labelled export not on this machine")
def test_the_stand_in_channel_uses_the_same_calibration_math_as_unity():
    data = json.loads(REAL.read_text(encoding="utf-8"))
    camera = {"yaw": data["yaw_deg"], "pitch": data["pitch_deg"], "position": data["position"]}
    R, t = pose(camera)
    assert np.allclose(R, np.asarray(data["R_world_to_cam"]), atol=1e-2)
    assert np.allclose(t, np.asarray(data["t_world_to_cam"]), atol=0.5)
    H = floor_homography(np.asarray(data["K"]), np.asarray(data["R_world_to_cam"]), np.asarray(data["t_world_to_cam"]), data["floors"]["U"]["floor_y"])
    expected = np.asarray(data["floors"]["U"]["H_floor_to_image"])
    assert np.allclose(H / np.abs(H).max(), expected / np.abs(expected).max(), atol=1e-3)


@pytest.mark.skipif(not REAL.exists(), reason="labelled export not on this machine")
def test_real_calib_puts_feet_near_the_security_queue():
    data = json.loads(REAL.read_text(encoding="utf-8"))
    calib = Calib(data)
    assert calib.level == "U"
    region = np.asarray(data["queues"][0]["region_image"], dtype=float)
    floor = np.asarray(data["queues"][0]["region_floor"], dtype=float)
    centre = region.mean(axis=0)
    # a box whose foot point is the centre of the queue's picture lands inside or close to the queue on the floor
    pt = calib.feet_to_floor(np.array([[centre[0] - 10, centre[1] - 60, 20, 60]]))[0]
    assert in_ring(np.array([pt[0]]), np.array([pt[1]]), floor)[0] or np.linalg.norm(pt - floor.mean(axis=0)) < 8
