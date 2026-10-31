"""The vision service. `python -m clarion_vision.service --source live|yolo|synthetic`. CLARION_URL and DEMO_TOKEN from the env."""
from __future__ import annotations

import argparse
import asyncio
import logging
import time

from . import contract
from .backend import Backend
from .chain import Chain
from .config import LIVE_DIR, Config
from .evac import plan_evacuation
from .queues import load_queues
from .sources.base import CameraSource, load_camera_specs
from .state import LaneBook
from .terminal import load_terminal

log = logging.getLogger("clarion.vision")


class Service:
    def __init__(self, config: Config, args):
        self.config, self.args = config, args
        self.terminal = load_terminal()
        self.book = LaneBook(self.terminal.initial_lanes)
        self.backend = Backend(config, self.on_command)
        self.source: CameraSource | None = None
        self.chain = self._chain(None)
        self.evacuating = False
        self.blocked: set[str] = set()
        self.ticks = 0
        self.last_plan_ms = None
        log.info("graph: %s, %d nodes, %d edges, %d exits; start lanes %s", self.terminal.source, len(self.terminal.nodes),
                 len(self.terminal.edges), len(self.terminal.exits), self.terminal.initial_lanes)

    def _chain(self, source: CameraSource | None, cctv=None) -> Chain:
        specs = source.camera_specs() if source else load_camera_specs()
        return Chain(self.terminal, specs, load_queues(cctv, lane_limits=self.terminal.lane_limits), self.book, corrections=None)

    def _open_source(self) -> None:
        kind = self.args.source
        if kind == "synthetic":
            from .sources.synthetic import SyntheticAirport
            specs, queues = load_camera_specs(), load_queues(lane_limits=self.terminal.lane_limits)
            def lanes(q):
                return self.book.lanes(q.lanes_key, q.default_lanes) if q.lanes_key else q.default_lanes
            self.source = SyntheticAirport(queues, specs, self.terminal, seed=self.args.seed, speed=self.args.speed, lanes_fn=lanes)
            self.chain = self._chain(self.source)
        elif kind == "live":
            from .sources.live_files import LiveFilesSource
            self.source = LiveFilesSource(self.args.live_dir)
            self.chain = self._chain(self.source, self.source.cctv)
        elif kind == "yolo":
            from .sources.yolo import YoloFramesSource
            self.source = YoloFramesSource(self.args.live_dir, weights=self.args.weights, device=self.args.device, hybrid=self.args.hybrid)
            self.chain = self._chain(self.source, self.source.cctv)
        log.info("camera input: %s (%s)", kind, self.source.detector)

    # -------------------------------------------------------------- ops.command
    async def on_command(self, cmd: dict) -> None:
        kind, cid = cmd.get("type"), cmd.get("id")
        log.info("ops.command %s %s", kind, {k: v for k, v in cmd.items() if k not in ("type", "id")})
        if kind == "staff" and cid:
            self.book.apply(cid, cmd.get("zone") or "", int(cmd.get("delta") or 0), self.chain.longest_group)
        elif kind == "evacuate":
            self.evacuating = True
            self.blocked |= set(cmd.get("zones") or [])
            await self.send_plan(cid)
        elif kind == "close":
            self.blocked.add(cmd.get("zone"))
            if self.evacuating:
                await self.send_plan(cid)
        elif kind == "open":
            self.blocked.discard(cmd.get("zone"))
            if self.evacuating:
                await self.send_plan(cid)

    async def send_plan(self, command_id: str) -> None:
        """Answer within 2 s (A10). The solver runs in a thread, the socket stays alive."""
        started = time.perf_counter()
        people, density, unseen = self.chain.zone_people()
        blocked = sorted(self.blocked)
        result = await asyncio.to_thread(plan_evacuation, self.terminal, people, blocked, density)
        data = result.to_contract(command_id)
        ok = await self.backend.send(contract.evac_plan(data), "evac.plan")
        self.last_plan_ms = (time.perf_counter() - started) * 1000
        log.info("evac.plan %s in %.0f ms: %.0f people seen, clear %.0f s, t90 %.0f s, %d exits, %d routes, allocator %s; blocked %s; "
                 "indoor zones no camera sees (counted as 0, not invented): %d%s",
                 "sent" if ok else "NOT SENT", self.last_plan_ms, result.people, result.clear_s, result.t90_s, len(result.exits), len(result.routes),
                 result.allocator, blocked, len(unseen), f"; unreachable {result.unreachable}" if result.unreachable else "")

    # -------------------------------------------------------------- loops
    async def ingest_loop(self) -> None:
        while not self.backend.stop:
            if self.source is None:
                try:
                    await asyncio.to_thread(self._open_source)
                except FileNotFoundError as e:
                    log.info("%s; retrying", e)
                    await asyncio.sleep(3.0)
                    continue
            sim = self.backend.sim
            tick = await asyncio.to_thread(self.source.read, sim)
            if tick is not None:
                self.chain.ingest(tick, sim.flights)
                self.ticks += 1
            else:
                await asyncio.sleep(0.1)

    async def report_loop(self) -> None:
        last_log = 0.0
        while not self.backend.stop:
            started = time.monotonic()
            sim = self.backend.sim
            self.book.sync(sim.staff_ops, self.chain.longest_group)
            if not sim.staff_ops and self.book.applied and sim.sim_time is None:
                self.book.reset()                              # POST /api/demo/reset
            if not self.evacuating:
                self.blocked = set(sim.blocked)
            elif not sim.blocked and self.backend.sim_ok and sim.sim_time is None:
                self.evacuating, self.blocked = False, set()   # POST /api/demo/reset
            report = self.chain.report(sim.flights)
            if report is not None:
                if report.rows:
                    await self.backend.send(contract.flow_report(report.rows), "flow.report")
                await self.backend.send(contract.crowd_positions(report.people), "crowd.positions")
            if started - last_log > 30.0:
                last_log = started
                log.info("t=%s detector=%s zones=%d people=%d ticks=%d sent=%s backend_errors=%d", report.t_s if report else None, self.chain.detector or "-",
                         len(report.rows) if report else 0, len(report.people) if report else 0, self.ticks, dict(self.backend.sent), len(self.backend.errors))
            await asyncio.sleep(max(0.0, self.config.report_period_s - (time.monotonic() - started)))

    async def run(self) -> None:
        tasks = [self.backend.run(), self.backend.poll(self.config.poll_period_s), self.ingest_loop(), self.report_loop()]
        await asyncio.gather(*tasks)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", choices=["live", "yolo", "synthetic"], default="live")
    ap.add_argument("--live-dir", default=str(LIVE_DIR))
    ap.add_argument("--weights", default=None)
    ap.add_argument("--device", default="auto", help="yolo only: 0, cpu, or auto (the GPU only when Unity leaves room)")
    ap.add_argument("--hybrid", action="store_true", help="yolo only: the other cameras keep the simulated detector")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--speed", type=float, default=10.0, help="synthetic only: sim seconds per real second")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    config = Config.from_env()
    if not config.token:
        log.warning("DEMO_TOKEN is not set: a backend with a token will refuse the socket")
    asyncio.run(Service(config, args).run())


if __name__ == "__main__":
    main()
