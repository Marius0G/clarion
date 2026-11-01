import { useEffect, useRef, type ReactNode, type PointerEvent } from "react";
import { animate, motion, useAnimationFrame, useInView, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform, useVelocity } from "motion/react";

/** Word-by-word blur reveal (after React Bits «BlurText», MIT), once, when the heading scrolls in. */
export function BlurText({ text, as = "h2", className }: { text: string; as?: "h2" | "h3"; className?: string }) {
  const reduce = useReducedMotion();
  const Tag = as === "h2" ? motion.h2 : motion.h3;
  const words = text.split(" ");
  return <Tag className={className} initial="hide" whileInView="show" viewport={{ once: true, amount: 0.6 }}
    transition={{ staggerChildren: reduce ? 0 : 0.045 }}>
    {words.map((w, i) => <span key={i}>
      <motion.span className="lp-word" variants={reduce ? {} : {
        hide: { opacity: 0, filter: "blur(10px)", y: 18 },
        show: { opacity: 1, filter: "blur(0px)", y: 0, transition: { type: "spring", bounce: 0, duration: 0.7 } },
      }}>{w}</motion.span>{i < words.length - 1 ? " " : ""}
    </span>)}
  </Tag>;
}

const FLAP = "ABCDEFGHIJKLMNOPRSTUVZĂÂÎȘȚ0123456789-:";

/** Departure-board split-flap: each cell shuffles through letters, then settles left to right. */
export function SplitFlap({ text, delay = 0 }: { text: string; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.8 });
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || !inView || reduce) return;
    const cells = Array.from(el.querySelectorAll<HTMLSpanElement>(".lp-flap"));
    const timers: number[] = [];
    cells.forEach((cell, i) => {
      const final = cell.dataset.c ?? "";
      if (final === " ") return;
      let n = 0;
      const stop = 6 + i * 2;
      timers.push(window.setTimeout(() => {
        const id = window.setInterval(() => {
          n++;
          if (n >= stop) { cell.textContent = final; cell.classList.remove("is-flipping"); window.clearInterval(id); return; }
          cell.textContent = FLAP[Math.floor(Math.random() * FLAP.length)] ?? "";
          cell.classList.add("is-flipping");
        }, 55);
        timers.push(id);
      }, delay));
    });
    return () => timers.forEach(id => { window.clearInterval(id); window.clearTimeout(id); });
  }, [inView, reduce, delay]);
  return <span ref={ref} className="lp-flaps" aria-label={text}>
    {Array.from(text).map((c, i) => <span key={i} aria-hidden="true" className="lp-flap" data-c={c}>{c === " " ? " " : c}</span>)}
  </span>;
}

/** Count-up number (after React Bits «CountUp»): writes the DOM directly, Romanian decimal comma. */
export function CountUp({ to, decimals = 0, from = 0 }: { to: number; decimals?: number; from?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  const fmt = (v: number) => v.toFixed(decimals).replace(".", ",");
  useEffect(() => {
    const el = ref.current;
    if (!el || !inView || reduce) return;
    const ctl = animate(from, to, { duration: 1.6, ease: [0.16, 1, 0.3, 1], onUpdate: v => { el.textContent = fmt(v); } });
    return () => ctl.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, reduce, to, from, decimals]);
  return <span ref={ref} className="lp-num">{fmt(to)}</span>;
}

/** Spotlight card (after React Bits «SpotlightCard»): a radial light follows the pointer. */
export function Spotlight({ className, children }: { className?: string; children: ReactNode }) {
  const move = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return <article className={`lp-spot ${className ?? ""}`} onPointerMove={move}>{children}</article>;
}

/** Magnet (after React Bits «Magnet»): the wrapped control leans toward the pointer, springs back on leave. */
export function Magnet({ children, strength = 0.28 }: { children: ReactNode; strength?: number }) {
  const reduce = useReducedMotion();
  const x = useMotionValue(0), y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 260, damping: 18 }), sy = useSpring(y, { stiffness: 260, damping: 18 });
  const move = (e: PointerEvent<HTMLSpanElement>) => {
    if (reduce || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    x.set((e.clientX - (r.left + r.width / 2)) * strength);
    y.set((e.clientY - (r.top + r.height / 2)) * strength);
  };
  return <motion.span className="lp-magnet" style={{ x: sx, y: sy }} onPointerMove={move} onPointerLeave={() => { x.set(0); y.set(0); }}>{children}</motion.span>;
}

/** Click spark (after React Bits «ClickSpark»): short radial sparks from the click point. */
export function ClickSpark({ children, color = "#2ee6ff" }: { children: ReactNode; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const spark = (e: React.MouseEvent<HTMLSpanElement>) => {
    const c = ref.current, ctx = c?.getContext("2d");
    if (!c || !ctx || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = c.getBoundingClientRect();
    c.width = r.width; c.height = r.height;
    const ox = e.clientX - r.left, oy = e.clientY - r.top, t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 420);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2, d = 10 + k * 34, len = 12 * (1 - k);
        ctx.beginPath(); ctx.moveTo(ox + Math.cos(a) * d, oy + Math.sin(a) * d); ctx.lineTo(ox + Math.cos(a) * (d + len), oy + Math.sin(a) * (d + len)); ctx.stroke();
      }
      if (k < 1) requestAnimationFrame(tick); else ctx.clearRect(0, 0, c.width, c.height);
    };
    requestAnimationFrame(tick);
  };
  return <span className="lp-spark" onClickCapture={spark}>{children}<canvas ref={ref} aria-hidden="true" /></span>;
}

/** Variable proximity (after React Bits «VariableProximity»): letters gain weight near the pointer. */
export function VariableProximity({ text, radius = 240, from = 300, to = 900 }: { text: string; radius?: number; from?: number; to?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    const letters = Array.from(el.querySelectorAll<HTMLSpanElement>(".lp-vp"));
    let px = -9999, py = -9999, raf = 0;
    const paint = () => {
      raf = 0;
      for (const l of letters) {
        const r = l.getBoundingClientRect();
        const d = Math.hypot(px - (r.left + r.width / 2), py - (r.top + r.height / 2));
        const f = Math.max(0, 1 - d / radius);
        l.style.fontVariationSettings = `'wght' ${Math.round(from + (to - from) * f * f)}`;
      }
    };
    const move = (e: globalThis.PointerEvent) => { px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(paint); };
    window.addEventListener("pointermove", move, { passive: true });
    return () => { window.removeEventListener("pointermove", move); cancelAnimationFrame(raf); };
  }, [reduce, radius, from, to]);
  return <span ref={ref} className="lp-vp-wrap">{Array.from(text).map((c, i) => <span key={i} className="lp-vp" style={{ fontVariationSettings: `'wght' ${from}` }}>{c}</span>)}</span>;
}

/** Scroll velocity strip (after React Bits «ScrollVelocity»): drifts sideways, faster while the page scrolls. */
export function ScrollVelocity({ text, base = 40 }: { text: string; base?: number }) {
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const { scrollY } = useScroll();
  const v = useSpring(useVelocity(scrollY), { damping: 50, stiffness: 400 });
  const factor = useTransform(v, [-1000, 0, 1000], [-4, 0, 4], { clamp: false });
  const pct = useTransform(x, val => `${((val % 50) - 50) % 50}%`);
  useAnimationFrame((_, delta) => {
    if (reduce) return;
    const dir = base < 0 ? -1 : 1;
    x.set(x.get() + dir * Math.abs(base) * (delta / 1000) * 0.1 * (1 + Math.abs(factor.get())));
  });
  return <div className="lp-velo" aria-hidden="true"><motion.div className="lp-velo-track" style={{ x: pct }}>
    {[0, 1, 2, 3].map(i => <span key={i}>{text}</span>)}
  </motion.div></div>;
}
