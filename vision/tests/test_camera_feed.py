"""camera.frame: the picture with its boxes, inside the size limit, one per camera and period, never a stale frame twice."""
import base64
import json

import numpy as np

from clarion_vision.camera_feed import JPEG_MAX_BYTES, CameraFeed, camera_ids, zone_of


def live(tmp_path, cameras):
    import cv2
    rng = np.random.default_rng(1)
    (tmp_path / "cctv.json").write_text(json.dumps({"cameras": [{"id": "cctv_security_queue", "queues_seen": [{"queue": "security", "coverage": 0.94}]},
                                                                {"id": "cctv_gates_mid", "queues_seen": []}]}))
    for i, camera in enumerate(cameras):
        (tmp_path / camera).mkdir()
        cv2.imwrite(str(tmp_path / camera / "f0.jpg"), rng.integers(0, 255, (720, 1280, 3), dtype=np.uint8))       # noise: the worst case for JPEG size
        (tmp_path / camera / "frame.json").write_text(json.dumps({"seq": 1, "t_s": 54000.0 + i, "file": "f0.jpg"}))
    return tmp_path


def test_frames_are_sent_once_with_boxes_and_fit_the_limit(tmp_path):
    root = live(tmp_path, ["cctv_security_queue", "cctv_gates_mid"])
    boxes = np.array([[100, 100, 40, 120, 0.9], [300, 200, 50, 150, 0.8]])
    feed = CameraFeed(root, "security_queue,gates_mid", device="cpu", detector=lambda image: boxes)
    messages = [json.loads(m) for m in feed.next_frames()]
    assert [m["data"]["camera"] for m in messages] == ["cctv_security_queue", "cctv_gates_mid"]
    first = messages[0]
    assert first["type"] == "camera.frame" and first["data"]["zone"] == "U_SECURITY_QUEUE" and messages[1]["data"]["zone"] is None
    assert first["data"]["count"] == 2 and first["data"]["detector"] == "yolo" and (first["data"]["w"], first["data"]["h"]) == (960, 540)
    assert len(base64.b64decode(first["data"]["jpeg"])) <= JPEG_MAX_BYTES and first["data"]["simTime"] == 54000.0
    assert feed.next_frames() == []                     # same picture: nothing new to send


def test_camera_names_and_zones():
    assert camera_ids("security_queue, cctv_hall_east") == ["cctv_security_queue", "cctv_hall_east"]
    assert len(camera_ids("a,b,c,d,e")) == 4
    assert zone_of({"queues_seen": [{"queue": "checkin_group_1", "coverage": 0.07}, {"queue": "checkin_group_2", "coverage": 0.99}]}) == "check_in:2"
    assert zone_of({"queues_seen": []}) is None
