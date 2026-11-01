import { useEffect, useRef } from "react";

/** Dotted night globe centred on Europe: great-circle arcs fly out of Craiova (CRA). Canvas 2D, no WebGL;
 *  pauses off-screen and draws a single still frame under prefers-reduced-motion. */
const CRA: [number, number] = [44.318, 23.889];
const ROUTES: [string, number, number][] = [
  ["LTN", 51.875, -0.368],
  ["BGY", 45.669, 9.704],
  ["BCN", 41.297, 2.078],
  ["DTM", 51.518, 7.612],
  ["CRL", 50.459, 4.453],
];
const RAD = Math.PI / 180;
type V3 = [number, number, number];

const vec = (lat: number, lon: number): V3 => {
  const p = lat * RAD, l = lon * RAD;
  return [Math.cos(p) * Math.sin(l), Math.sin(p), Math.cos(p) * Math.cos(l)];
};

function fibonacci(n: number): V3[] {
  const out: V3[] = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), t = g * i;
    out.push([Math.cos(t) * r, y, Math.sin(t) * r]);
  }
  return out;
}

function arc(a: V3, b: V3, steps: number): V3[] {
  const dot = Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
  const w = Math.acos(dot), s = Math.sin(w), lift = 0.05 + w * 0.3;
  const pts: V3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, k1 = Math.sin((1 - t) * w) / s, k2 = Math.sin(t * w) / s, h = 1 + lift * Math.sin(Math.PI * t);
    pts.push([(a[0] * k1 + b[0] * k2) * h, (a[1] * k1 + b[1] * k2) * h, (a[2] * k1 + b[2] * k2) * h]);
  }
  return pts;
}

export default function FlightGlobe({ still = false }: { still?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dots = fibonacci(1500);
    const home = vec(...CRA);
    // Diagram scale: offsets from CRA are stretched 2.2x so the European routes read at globe size.
    const stretch = (lat: number, lon: number) => vec(CRA[0] + (lat - CRA[0]) * 2.2, CRA[1] + (lon - CRA[1]) * 2.2);
    const routes = ROUTES.map(([code, lat, lon], i) => ({ code, end: stretch(lat, lon), path: arc(home, stretch(lat, lon), 72), phase: i * 0.21 }));
    let w = 0, h = 0, dpr = 1, raf = 0, visible = true, px = 0, tx = 0;
    const size = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    };
    size();

    const draw = (time: number) => {
      const t = time / 1000;
      px += (tx - px) * 0.04;
      const lon0 = -2 + Math.sin(t * 0.08) * 6 + px * 9, lat0 = 40;
      const cy = Math.cos(lon0 * RAD), sy = Math.sin(lon0 * RAD), cx = Math.cos(lat0 * RAD), sx = Math.sin(lat0 * RAD);
      const R = Math.min(w, h) * 0.46, ox = w / 2, oy = h / 2;
      const proj = (v: V3): V3 => {
        const x1 = v[0] * cy - v[2] * sy, z1 = v[0] * sy + v[2] * cy;
        const y2 = v[1] * cx - z1 * sx, z2 = v[1] * sx + z1 * cx;
        return [ox + x1 * R, oy - y2 * R, z2];
      };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const halo = ctx.createRadialGradient(ox, oy, R * 0.55, ox, oy, Math.min(w, h) / 2);
      halo.addColorStop(0, "rgba(61,107,255,0.20)");
      halo.addColorStop(0.75, "rgba(61,107,255,0.05)");
      halo.addColorStop(1, "rgba(61,107,255,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);
      ctx.beginPath();
      ctx.arc(ox, oy, R, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(120,150,255,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();

      for (const d of dots) {
        const [x, y, z] = proj(d);
        if (z < 0) continue;
        const s = 0.7 + z * 1.3;
        ctx.fillStyle = `rgba(120,150,255,${0.12 + z * 0.55})`;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }

      ctx.font = "500 12px 'Geist Mono', ui-monospace, monospace";
      for (const r of routes) {
        const pts = r.path.map(proj);
        ctx.beginPath();
        pts.forEach(([x, y], i) => { if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.strokeStyle = "rgba(255,210,26,0.22)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        const p = (t * 0.14 + r.phase) % 1, head = Math.floor(p * (pts.length - 1)), tail = Math.max(0, head - 22);
        const grad = ctx.createLinearGradient(pts[tail]![0], pts[tail]![1], pts[head]![0], pts[head]![1]);
        grad.addColorStop(0, "rgba(255,210,26,0)");
        grad.addColorStop(1, "rgba(255,210,26,0.95)");
        ctx.beginPath();
        for (let i = tail; i <= head; i++) { if (i === tail) ctx.moveTo(pts[i]![0], pts[i]![1]); else ctx.lineTo(pts[i]![0], pts[i]![1]); }
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.2;
        ctx.stroke();
        const [hx, hy] = pts[head]!;
        ctx.fillStyle = "#fff6cf";
        ctx.beginPath(); ctx.arc(hx, hy, 2.4, 0, Math.PI * 2); ctx.fill();
        const [ex, ey, ez] = proj(r.end);
        if (ez > 0) {
          ctx.fillStyle = "#ffd21a";
          ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "rgba(238,241,255,0.85)";
          ctx.fillText(r.code, ex + 7, ey + 4);
        }
      }

      const [hx, hy] = proj(home);
      const pulse = (t * 0.6) % 1;
      ctx.strokeStyle = `rgba(255,61,78,${1 - pulse})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(hx, hy, 5 + pulse * 22, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#ff3d4e";
      ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#eef1ff";
      ctx.font = "600 13px 'Geist Mono', ui-monospace, monospace";
      ctx.fillText("CRA", hx + 10, hy - 8);
    };

    const loop = (time: number) => {
      draw(time);
      if (visible) raf = requestAnimationFrame(loop);
    };
    const onMove = (e: PointerEvent) => { tx = (e.clientX / window.innerWidth - 0.5) * 2; };
    const ro = new ResizeObserver(() => { size(); if (still) draw(4000); });
    ro.observe(canvas);
    if (still) { draw(4000); return () => ro.disconnect(); }
    const io = new IntersectionObserver(([entry]) => {
      const was = visible;
      visible = Boolean(entry?.isIntersecting) && !document.hidden;
      if (visible && !was) raf = requestAnimationFrame(loop);
    });
    io.observe(canvas);
    window.addEventListener("pointermove", onMove, { passive: true });
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); window.removeEventListener("pointermove", onMove); };
  }, [still]);

  return <canvas ref={ref} className="lp-globe-canvas" aria-hidden="true" />;
}
