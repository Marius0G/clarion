"""Zone and node ids (D26). Mirrors backend/src/mapIds.ts, plus the lane keys Unity and the backend agree on."""
from __future__ import annotations

import re

ID_ALIASES = {
    "entrance": "G_DEPARTURES", "security": "U_SECURITY_QUEUE", "airside": "U_CORRIDOR_EAST",
    "check_in": "G_CHECKIN_QUEUE", "bag_drop": "G_CHECKIN_DESKS",
    "arrivals_hall": "G_MEETING", "taxi_rank": "X_TAXI_RANK", "kerb": "X_KERB_DEPARTURES",
    "exit_1": "door_exit_west", "exit_2": "door_exit_mid", "team_post": "G_INFO",
}
GROUPS = ("1", "2", "3")                                  # three physical groups of 4 desks, assigned per flight by time slot
GROUP_ALIASES = {"W6": "1", "RO": "2", "FR": "3"}         # legacy per-airline names; check_in:OTHER has no desks
NODE_ID = re.compile(r"^(?:[a-z][a-z0-9_]{0,39}(?:_[GU])?(:[A-Za-z0-9_-]{1,16})?|[A-Z][A-Z0-9_]{0,39})$")


def is_whole_terminal(ids) -> bool:
    """Unity evacuates everybody for these ids (ClarionBridge.IsWhole); any other zone list evacuates only the people in those zones."""
    return any(i in ("T2", "ALL", "TERMINAL") for i in ids)


def is_node_id(value) -> bool:
    return isinstance(value, str) and NODE_ID.match(value) is not None


def _group(name: str) -> str | None:
    return name if name in GROUPS else GROUP_ALIASES.get(name.upper())


def map_node_id(node: str) -> str:
    """Canonical physical anchor of an id, the same answer as mapNodeId in the backend."""
    gate = re.match(r"^(?:G|gate_|U_GATE_)(10|[1-9])$", node)
    if gate:
        return f"U_GATE_{gate.group(1)}"
    group = re.match(r"^(?:check_in|bag_drop):(.+)$", node)
    if group:
        g = _group(group.group(1))
        return f"check_in:{g}" if g else node
    return ID_ALIASES.get(node, node)


def lanes_key(zone: str) -> str | None:
    """The lane counter a staff command changes: `security`, `check_in:N`, or None for a zone without lanes.
    Ids without a group (G_CHECKIN_QUEUE, check_in, bag_drop...) return the marker `check_in:?`: Unity sends those to
    the group with the longest queue at that moment, so the caller resolves it the same way."""
    if zone in ("security", "U_SECURITY_QUEUE", "U_SECURITY"):
        return "security"
    m = re.match(r"^(?:check_in|bag_drop):(.+)$", zone)
    if m:
        g = _group(m.group(1))
        return f"check_in:{g}" if g else None
    m = re.match(r"^checkin_group_(\d+)$", zone)
    if m:
        return f"check_in:{m.group(1)}"
    if zone in ("check_in", "bag_drop", "G_CHECKIN_QUEUE", "G_CHECKIN_DESKS"):
        return "check_in:?"
    return None
