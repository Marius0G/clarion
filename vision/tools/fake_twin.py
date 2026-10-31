"""A stand-in for Unity on the worker's socket (client=twin), for the local smoke test: sends sim.status and flight.update,
acks every ops.command, registers one simulated subscriber and prints what it receives. Never used in a real run."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit

import websockets

SPEED = float(os.environ.get("FAKE_TWIN_SPEED", "10"))
START_S = float(os.environ.get("FAKE_TWIN_START_S", 8.0 * 3600))
FLIGHTS = [
    {"flight": "W6 3751", "airline": "W6", "destination": "Londra Luton", "std": "09:40", "gate": "gate_2", "checkIn": "check_in:1",
     "checkInDesks": ["checkin_1", "checkin_2", "checkin_3", "checkin_4"], "gateCloseAt": "09:10", "status": "scheduled", "delayMin": 0, "pax": 180},
    {"flight": "RO 7653", "airline": "RO", "destination": "Bucuresti", "std": "10:20", "gate": "gate_5", "checkIn": "check_in:2",
     "checkInDesks": ["checkin_5", "checkin_6", "checkin_7", "checkin_8"], "gateCloseAt": "09:55", "status": "scheduled", "delayMin": 0, "pax": 68},
    {"flight": "FR 2214", "airline": "FR", "destination": "Londra Stansted", "std": "10:45", "gate": "gate_3", "checkIn": "check_in:3",
     "checkInDesks": ["checkin_9", "checkin_10", "checkin_11", "checkin_12"], "gateCloseAt": "10:15", "status": "scheduled", "delayMin": 0, "pax": 189},
]


def envelope(kind: str, data: dict) -> str:
    return json.dumps({"type": kind, "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "data": data})


async def main() -> None:
    url = os.environ.get("CLARION_URL", "http://127.0.0.1:8788")
    token = os.environ.get("DEMO_TOKEN", "")
    p = urlsplit(url)
    ws_url = f"{'wss' if p.scheme == 'https' else 'ws'}://{p.netloc}/ws?client=twin" + (f"&token={token}" if token else "")
    async with websockets.connect(ws_url, max_size=8 * 1024 * 1024) as ws:
        flights = FLIGHTS
        if os.environ.get("FAKE_TWIN_FLIGHTS"):        # a recorded run's flights.jsonl, first line: the schedule that run had
            with open(os.environ["FAKE_TWIN_FLIGHTS"], encoding="utf-8") as handle:
                flights = json.loads(handle.readline())["flights"]
        await ws.send(envelope("flight.update", {"flights": flights}))
        await ws.send(envelope("agent.register", {"agentId": "smoke-agent", "role": "passenger_terminal", "channel": "sim", "flight": "W6 3751"}))
        loop = asyncio.get_running_loop()
        t0 = loop.time()

        async def status():
            while True:
                await ws.send(envelope("sim.status", {"running": True, "scenario": "smoke", "arm": "B", "coverage": 1, "seed": 1,
                                                      "simTime": START_S + (loop.time() - t0) * SPEED, "speed": SPEED, "agents": 1}))
                await asyncio.sleep(1.0)

        async def receive():
            async for message in ws:
                event = json.loads(message)
                kind = event.get("type")
                if kind == "ops.command":
                    print("TWIN ops.command", json.dumps(event["data"]), flush=True)
                    await ws.send(envelope("ops.ack", {"id": event["data"]["id"]}))
                elif kind == "agent.route":
                    print("TWIN agent.route", json.dumps(event["data"], ensure_ascii=True), flush=True)
                elif kind == "agent.message":
                    print("TWIN agent.message", json.dumps(event["data"], ensure_ascii=True)[:300], flush=True)
                elif kind == "error":
                    print("TWIN error", event["data"], flush=True)

        await asyncio.gather(status(), receive())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
