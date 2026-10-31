"""A9's sources where no camera looks. A zone without a camera stays unknown everywhere else (D0: it is never in flow.report), but
an evacuation that counts it as empty would clear too fast, so the plan alone estimates it, at low confidence, from what D0
allows: the schedule, the presentation curve and the flows the cameras measured. The plan says it is partly estimated.

Airside: who has passed security by now = passengers of the flights still here x how many have presented x the camera-measured
scale, less those still in the security queue and those seen airside. A flight near departure keeps most of its people at its gate.
Landside: the density of the halls the cameras do see."""
from __future__ import annotations

from .forecast import Curve, Flight
from .mapids import map_node_id
from .terminal import Terminal

AT_GATE_SHARE_NEAR, AT_GATE_SHARE_EARLY, NEAR_DEPARTURE_MIN = 0.8, 0.25, 45.0
NOT_A_HALL = ("queue", "service")     # their crowds say nothing about a corridor's


def estimate_unseen(terminal: Terminal, seen: dict[str, float], unseen: list[str], flights: list[Flight], t_s: float, curve: Curve,
                    scale: float = 1.0, still_before_security: float = 0.0) -> dict[str, float]:
    """People per unseen indoor zone."""
    zones = terminal.zones
    airside = [z for z in unseen if z in zones and zones[z].side == "airside"]
    landside = [z for z in unseen if z in zones and zones[z].side != "airside"]
    out: dict[str, float] = {}

    weights = {z: zones[z].area_m2 / 100.0 for z in airside}
    passed = 0.0
    for f in flights:
        minutes_left = (f.etd_s - t_s) / 60.0
        if f.status in ("cancelled", "departed") or f.pax <= 0 or minutes_left <= 0:
            continue
        people = f.pax * scale * curve.presented_by(minutes_left)
        passed += people
        gate = map_node_id(f.gate) if f.gate else None
        if gate in weights:
            weights[gate] += people * (AT_GATE_SHARE_NEAR if minutes_left <= NEAR_DEPARTURE_MIN else AT_GATE_SHARE_EARLY)
    seen_airside = sum(n for z, n in seen.items() if z in zones and zones[z].side == "airside")
    remaining = max(0.0, passed - still_before_security - seen_airside)
    total_weight = sum(weights.values())
    if remaining > 0 and total_weight > 0:
        out.update({z: remaining * w / total_weight for z, w in weights.items()})

    halls = [z for z in seen if z in zones and zones[z].side != "airside" and zones[z].level in ("G", "U") and zones[z].kind not in NOT_A_HALL]
    area = sum(zones[z].area_m2 for z in halls)
    if area > 0:
        density = sum(seen[z] for z in halls) / area
        out.update({z: density * zones[z].area_m2 for z in landside})
    return {z: n for z, n in out.items() if n > 0}
