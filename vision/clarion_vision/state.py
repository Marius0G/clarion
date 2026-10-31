"""What the service knows from the backend: the schedule, the clock and the admin's decisions, nothing else (D0).
GET /api/sim also returns Unity's truth and the agents' positions. `SimView.parse` keeps a whitelist, so those fields never
enter the service."""
from __future__ import annotations

from dataclasses import dataclass, field

from .forecast import Flight
from .mapids import lanes_key

SIM_FIELDS = ("simTime", "speed", "connected", "blocked", "flights", "ops")   # the whitelist: never truth, flow, agents, counts


@dataclass
class SimView:
    sim_time: float | None = None
    speed: float | None = None
    twin_connected: bool = False
    blocked: list[str] = field(default_factory=list)
    flights: list[Flight] = field(default_factory=list)
    staff_ops: list[dict] = field(default_factory=list)

    @staticmethod
    def parse(raw: dict) -> "SimView":
        data = {k: raw.get(k) for k in SIM_FIELDS}
        flights = [f for f in (Flight.parse(r) for r in data["flights"] or []) if f is not None]
        ops = [{"id": o.get("id"), "zone": o.get("zone"), "delta": o.get("delta")}
               for o in (data["ops"] or []) if o.get("type") == "staff"]
        return SimView(data["simTime"], data["speed"], bool(data["connected"]), list(data["blocked"] or []), flights, ops)


class LaneBook:
    """Open lanes per queue (`security`, `check_in:N`), starting from the plan's values plus every staff command. Reads the
    backend's command list, not its lane table: the table keys by the id it was sent (`U_SECURITY_QUEUE` and `security`
    diverge) and starts from stale values. An id without a group goes to the longest group, the rule Unity follows."""

    def __init__(self, initial: dict[str, int]):
        self.initial = dict(initial)
        self.applied: dict[str, tuple[str, int]] = {}

    def apply(self, command_id: str, zone: str, delta: int, longest_group=None) -> None:
        if command_id in self.applied:
            return
        key = lanes_key(zone)
        if key == "check_in:?":
            key = longest_group() if longest_group else None
        if key:
            self.applied[command_id] = (key, int(delta))

    def sync(self, staff_ops: list[dict], longest_group=None) -> None:
        for op in staff_ops:
            if op.get("id") and op.get("zone") and op.get("delta") is not None:
                self.apply(op["id"], op["zone"], op["delta"], longest_group)

    def reset(self) -> None:
        self.applied.clear()

    def lanes(self, key: str, default: int = 0) -> int:
        n = self.initial.get(key, default)
        for k, delta in self.applied.values():
            if k == key:
                n += delta
        return max(0, n)
