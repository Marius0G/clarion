"""Service settings. The URL and token come only from the environment; the token is never logged."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

VISION_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = VISION_DIR.parent
MAP_DIR = REPO_DIR / "docs" / "contract" / "map"
TERMINAL_JSON = REPO_DIR / "docs" / "contract" / "terminal.json"
DATA_DIR = VISION_DIR / "data"
UNITY_REPO = Path(os.environ.get("CLARION_UNITY_REPO", REPO_DIR.parent / "craiova-3d-model"))
LIVE_DIR = Path(os.environ.get("CLARION_CCTV_LIVE", UNITY_REPO / "data" / "interim" / "cctv_live"))


@dataclass(frozen=True)
class Config:
    url: str = "http://127.0.0.1:8788"
    token: str = field(default="", repr=False)
    report_period_s: float = 1.0     # contract: flow.report and crowd.positions at most 1/s
    poll_period_s: float = 1.0       # GET /api/sim (schedule, simTime, lanes, blocked)

    @staticmethod
    def from_env() -> "Config":
        return Config(url=os.environ.get("CLARION_URL", "http://127.0.0.1:8788").rstrip("/"),
                      token=os.environ.get("DEMO_TOKEN", ""))

    @property
    def ws_url(self) -> str:
        p = urlsplit(self.url)
        scheme = "wss" if p.scheme == "https" else "ws"
        query = "client=vision" + (f"&token={self.token}" if self.token else "")
        return urlunsplit((scheme, p.netloc, "/ws", query, ""))

    def redact(self, text: object) -> str:
        """Any text about to be logged, with the token removed."""
        s = str(text)
        return s.replace(self.token, "***") if self.token else s
