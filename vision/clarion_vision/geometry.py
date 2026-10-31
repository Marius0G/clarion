"""Floor geometry: polygon tests, a raster of the zones, what each camera covers, and pixels to floor metres."""
from __future__ import annotations

import numpy as np

from .terminal import Terminal, Zone

CELL_M = {"G": 0.25, "U": 0.25, "X": 0.5}


def in_ring(xs: np.ndarray, zs: np.ndarray, ring: np.ndarray) -> np.ndarray:
    """Ray casting, vectorised over the points."""
    xs, zs = np.asarray(xs, dtype=float), np.asarray(zs, dtype=float)
    hit = np.zeros(xs.shape, dtype=bool)
    if len(ring) < 3 or xs.size == 0:
        return hit
    ax, az = ring[:, 0], ring[:, 1]
    bx, bz = np.roll(ax, 1), np.roll(az, 1)
    for x0, z0, x1, z1 in zip(ax, az, bx, bz):
        crosses = (z0 > zs) != (z1 > zs)
        if crosses.any():
            with np.errstate(divide="ignore", invalid="ignore"):
                hit ^= crosses & (xs < (x1 - x0) * (zs - z0) / (z1 - z0) + x0)
    return hit


def in_zone(xs: np.ndarray, zs: np.ndarray, zone: Zone) -> np.ndarray:
    out = np.zeros(np.shape(xs), dtype=bool)
    for outer, holes in zone.polygons:
        inside = in_ring(xs, zs, outer)
        for hole in holes:
            inside &= ~in_ring(xs, zs, hole)
        out |= inside
    return out


class ZoneIndex:
    """Which zone a floor point is in, by lookup in a raster per level. Painted largest first, so a small zone drawn over a
    large one keeps its cells. Also the cells of each zone, for the coverage tests."""

    _cache: dict[int, "ZoneIndex"] = {}

    @classmethod
    def of(cls, terminal: Terminal) -> "ZoneIndex":
        """A few seconds to build and it never changes for a terminal, so built once."""
        key = id(terminal)
        if key not in cls._cache:
            cls._cache[key] = cls(terminal)
        return cls._cache[key]

    def __init__(self, terminal: Terminal):
        self.ids = list(terminal.zones)
        self.area = {z.id: z.area_m2 for z in terminal.zones.values()}
        self.frames: dict[str, tuple[float, float, float, int, int]] = {}
        self.grids: dict[str, np.ndarray] = {}
        self.cells: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        by_level: dict[str, list[Zone]] = {}
        for z in terminal.zones.values():
            by_level.setdefault(z.level, []).append(z)
        for level, zones in by_level.items():
            cell = CELL_M.get(level, 0.5)
            all_pts = np.vstack([outer for z in zones for outer, _ in z.polygons])
            x0, z0 = all_pts.min(axis=0) - cell
            x1, z1 = all_pts.max(axis=0) + cell
            nx, nz = int((x1 - x0) / cell) + 1, int((z1 - z0) / cell) + 1
            grid = np.full((nz, nx), -1, dtype=np.int16)
            cx = x0 + (np.arange(nx) + 0.5) * cell
            cz = z0 + (np.arange(nz) + 0.5) * cell
            for zone in sorted(zones, key=lambda z: -z.area_m2):
                for outer, holes in zone.polygons:
                    (bx0, bz0), (bx1, bz1) = outer.min(axis=0), outer.max(axis=0)
                    ix = np.nonzero((cx >= bx0) & (cx <= bx1))[0]
                    iz = np.nonzero((cz >= bz0) & (cz <= bz1))[0]
                    if not ix.size or not iz.size:
                        continue
                    mx, mz = np.meshgrid(cx[ix], cz[iz])
                    inside = in_ring(mx, mz, outer)
                    for hole in holes:
                        inside &= ~in_ring(mx, mz, hole)
                    sub = grid[np.ix_(iz, ix)]
                    sub[inside] = self.ids.index(zone.id)
                    grid[np.ix_(iz, ix)] = sub
            self.frames[level] = (x0, z0, cell, nx, nz)
            self.grids[level] = grid
            for i, zone_id in enumerate(self.ids):
                if terminal.zones[zone_id].level != level:
                    continue
                iz, ix = np.nonzero(grid == i)
                self.cells[zone_id] = (cx[ix], cz[iz])

    def lookup(self, level: str, xs: np.ndarray, zs: np.ndarray) -> np.ndarray:
        """Zone indexes for floor points; -1 off every zone."""
        xs, zs = np.asarray(xs, dtype=float), np.asarray(zs, dtype=float)
        if level not in self.frames or xs.size == 0:
            return np.full(xs.shape, -1, dtype=np.int16)
        x0, z0, cell, nx, nz = self.frames[level]
        ix = ((xs - x0) / cell).astype(int)
        iz = ((zs - z0) / cell).astype(int)
        ok = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)
        out = np.full(xs.shape, -1, dtype=np.int16)
        out[ok] = self.grids[level][iz[ok], ix[ok]]
        return out


def ring_samples(ring: np.ndarray, cell: float = 0.25) -> tuple[np.ndarray, np.ndarray]:
    (x0, z0), (x1, z1) = ring.min(axis=0), ring.max(axis=0)
    mx, mz = np.meshgrid(np.arange(x0, x1 + cell, cell), np.arange(z0, z1 + cell, cell))
    inside = in_ring(mx, mz, ring)
    return mx[inside], mz[inside]


class Calib:
    """A camera's calib.json: foot points in pixels to floor metres, through the lens and H_image_to_floor."""

    def __init__(self, data: dict):
        self.K = np.asarray(data["K"], dtype=np.float64)
        self.dist = np.asarray(data.get("dist_opencv", [0, 0, 0, 0]), dtype=np.float64)
        self.level = data["level"]
        self.H = np.asarray(data["floors"][self.level]["H_image_to_floor"], dtype=np.float64)

    def feet_to_floor(self, boxes: np.ndarray) -> np.ndarray:
        """boxes = N x 4 of x, y, w, h (top-left corner, pixels). Returns N x 2 of floor x, z."""
        boxes = np.asarray(boxes, dtype=np.float64)
        if boxes.size == 0:
            return np.empty((0, 2))
        feet = np.stack((boxes[:, 0] + boxes[:, 2] / 2.0, boxes[:, 1] + boxes[:, 3]), axis=1)
        if np.any(self.dist != 0):
            import cv2
            feet = cv2.undistortPoints(feet.reshape(-1, 1, 2), self.K, self.dist, P=self.K).reshape(-1, 2)
        homogeneous = np.column_stack((feet, np.ones(len(feet))))
        floor = homogeneous @ self.H.T
        return floor[:, :2] / floor[:, 2:3]
