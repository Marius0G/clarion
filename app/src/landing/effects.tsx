import { useEffect, useRef, type ReactNode, type PointerEvent } from "react";
import { animate, motion, useInView, useReducedMotion } from "motion/react";

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
