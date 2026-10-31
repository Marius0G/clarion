"""The socket and the polling. Vision opens no ports; it connects to the backend as client=vision (contract)."""
from __future__ import annotations

import asyncio
import json
import logging
from collections import Counter
from typing import Awaitable, Callable

import httpx
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .config import Config
from .state import SimView

log = logging.getLogger("clarion.backend")
logging.getLogger("websockets").setLevel(logging.WARNING)      # its debug lines would carry the URL with the token
logging.getLogger("httpx").setLevel(logging.WARNING)


class Backend:
    def __init__(self, config: Config, on_command: Callable[[dict], Awaitable[None]]):
        self.config, self.on_command = config, on_command
        self.ws = None
        self.connected = asyncio.Event()
        self.sim = SimView()
        self.sim_ok = False
        self.stop = False
        self.sent: Counter = Counter()
        self.errors: list[str] = []

    async def run(self) -> None:
        delay = 1.0
        while not self.stop:
            try:
                async with websockets.connect(self.config.ws_url, max_size=8 * 1024 * 1024, open_timeout=10) as ws:
                    self.ws = ws
                    self.connected.set()
                    delay = 1.0
                    log.info("connected to %s as client=vision", self.config.url)
                    async for message in ws:
                        await self._receive(message)
            except ConnectionClosed as e:
                if e.rcvd and e.rcvd.code == 4001:
                    log.error("a newer vision client replaced this one; stopping")
                    self.stop = True
                    break
                log.warning("socket closed: %s", self.config.redact(e))
            except (OSError, InvalidStatus, asyncio.TimeoutError) as e:
                log.warning("cannot reach the backend: %s", self.config.redact(e))
            finally:
                self.ws = None
                self.connected.clear()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 15.0)

    async def _receive(self, message) -> None:
        try:
            event = json.loads(message)
        except (TypeError, ValueError):
            return
        kind = event.get("type")
        if kind == "error":
            text = str((event.get("data") or {}).get("message"))
            self.errors.append(text)
            del self.errors[:-50]
            log.error("backend rejected a message: %s", text)
        elif kind == "ops.command":
            await self.on_command(event.get("data") or {})

    async def send(self, text: str, kind: str) -> bool:
        ws = self.ws
        if ws is None:
            return False
        try:
            await ws.send(text)
            self.sent[kind] += 1
            return True
        except ConnectionClosed:
            return False

    async def poll(self, period_s: float) -> None:
        """Schedule, clock and admin decisions from GET /api/sim. SimView.parse drops everything else, truth included."""
        async with httpx.AsyncClient(base_url=self.config.url, timeout=3.0, trust_env=False) as client:
            while not self.stop:
                try:
                    response = await client.get("/api/sim")
                    response.raise_for_status()
                    self.sim = SimView.parse(response.json())
                    self.sim_ok = True
                except (httpx.HTTPError, ValueError) as e:
                    if self.sim_ok:
                        log.warning("GET /api/sim failed: %s", self.config.redact(e))
                    self.sim_ok = False
                await asyncio.sleep(period_s)
