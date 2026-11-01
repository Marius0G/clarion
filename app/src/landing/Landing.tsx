import { lazy, Suspense, useRef } from "react";
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import "@fontsource-variable/big-shoulders-display";
import "./landing.css";
import { BlurText, CountUp, SplitFlap, Spotlight } from "./effects";

const FlightGlobe = lazy(() => import("./FlightGlobe"));

/** Public main page: what Clarion does for passengers, then «Abonează-te» → /join (sign-in, Wallet card, WhatsApp START link). */
const WHATSAPP_START = "https://wa.me/15556318672?text=START";

const BOARD: readonly { code: string; text: string; detail: string; alert?: boolean }[] = [
  { code: "PLECARE", text: "Când să pleci spre aeroport", detail: "din coada de acum, de pe camere, și din zborurile zilei" },
  { code: "CHECK-IN", text: "Cât stai la check-in și la securitate", detail: "în minute, pentru fiecare etapă" },
  { code: "POARTA", text: "Poarta ta și drumul până la ea", detail: "cu timpul de mers de la securitate" },
  { code: "ZBOR", text: "Întârzieri și anulări", detail: "imediat ce apar" },
  { code: "EVACUARE", text: "Drumul spre ieșire, din locul în care ești", detail: "spre cea mai apropiată ieșire liberă", alert: true },
  { code: "PE DRUM", text: "„Nu veni acum” și cât să aștepți", detail: "dacă ești deja pe drum când apare o criză", alert: true },
];

const PROOF: readonly { label: string; note: string; before: number; after: number; unit: string; decimals: number }[] = [
  { label: "Așteptare medie la securitate", note: "media tuturor pasagerilor", before: 14.3, after: 7.2, unit: "min", decimals: 1 },
  { label: "Așteptare la securitate, p90", note: "9 din 10 pasageri așteaptă cel mult atât", before: 31, after: 12.3, unit: "min", decimals: 1 },
  { label: "Evacuare: 90 % din oameni afară", note: "timpul până ies 9 din 10 oameni", before: 190, after: 149.5, unit: "s", decimals: 1 },
];

const LIGHTS = Array.from({ length: 28 }, (_, i) => i);
const BOXES: readonly [number, number, number][] = [
  [8, 52, 0], [17, 47, 1], [26, 55, 2], [35, 49, 0], [44, 53, 1], [53, 46, 2], [62, 51, 0], [71, 48, 1], [80, 54, 2], [22, 72, 1], [48, 70, 0], [68, 73, 2],
];

function Hero() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const p = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.4 });
  const k = reduce ? 0 : 1;
  const globeY = useTransform(p, [0, 1], [0, 260 * k]);
  const globeScale = useTransform(p, [0, 1], [1, 1 - 0.12 * k]);
  const line1 = useTransform(p, [0, 1], [0, -40 * k]);
  const line2 = useTransform(p, [0, 1], [0, -90 * k]);
  const line3 = useTransform(p, [0, 1], [0, -140 * k]);
  const chipsFast = useTransform(p, [0, 1], [0, -320 * k]);
  const chipsSlow = useTransform(p, [0, 1], [0, -140 * k]);
  const fade = useTransform(p, [0, 0.8], [1, reduce ? 1 : 0.2]);
  const curvesY = useTransform(p, [0, 1], [0, 120 * k]);
  const draw = (d: number) => reduce ? {} : { initial: { pathLength: 0, opacity: 0 }, animate: { pathLength: 1, opacity: 1 }, transition: { duration: 2.6, ease: [0.16, 1, 0.3, 1] as const, delay: d } };
  const rise = (d: number) => reduce ? {} : { initial: { opacity: 0, y: 40, filter: "blur(12px)" }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, transition: { type: "spring" as const, bounce: 0, duration: 1.1, delay: d } };

  return <section ref={ref} className="lp-hero" aria-labelledby="landing-title">
    <motion.svg className="lp-curves" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" style={{ y: curvesY }} aria-hidden="true">
      <motion.path d="M -40 930 C 260 930, 380 330, 700 360 S 1080 900, 1640 140" {...draw(0.2)} />
      <motion.path className="lp-curve-2" d="M -40 990 C 520 990, 980 760, 1640 820" {...draw(0.5)} />
    </motion.svg>
    <motion.div className="lp-globe" style={{ y: globeY, scale: globeScale }}>
      <div className="lp-radar" aria-hidden="true" />
      <Suspense fallback={<div className="lp-globe-fallback" aria-hidden="true" />}>
        <FlightGlobe still={Boolean(reduce)} />
      </Suspense>
    </motion.div>

    <motion.div className="lp-hero-copy" style={{ opacity: fade }}>
      <h1 id="landing-title" className="lp-h1">
        <motion.span className="lp-h1-lead" {...rise(0.05)}>Clarion transformă aglomerația din aeroport în instrucțiuni personale:</motion.span>{" "}
        <motion.span className="lp-h1-line" style={{ y: line1 }}><motion.span {...rise(0.15)}>când să vii,</motion.span></motion.span>{" "}
        <motion.span className="lp-h1-line" style={{ y: line2 }}><motion.span {...rise(0.25)}>pe unde să intri</motion.span></motion.span>{" "}
        <motion.span className="lp-h1-line" style={{ y: line3 }}><motion.span {...rise(0.35)}>și unde să te duci</motion.span></motion.span>{" "}
        <motion.span className="lp-h1-tail" {...rise(0.5)}>când ceva merge prost.</motion.span>
      </h1>
      <motion.div className="lp-actions" {...rise(0.6)}>
        <a className="lp-btn lp-btn-sign" href="/join">Abonează-te</a>
        <a className="lp-btn lp-btn-ghost" href={WHATSAPP_START} target="_blank" rel="noopener noreferrer">Scrie-ne pe WhatsApp</a>
      </motion.div>
    </motion.div>

    <motion.div className="lp-chip lp-chip-msg" style={{ y: chipsFast }} aria-hidden="true">
      <span className="lp-chip-from">Clarion, pe WhatsApp</span>
      <span>Pleacă spre aeroport la 11:40. La securitate se așteaptă acum 7 minute.</span>
      <small>exemplu de mesaj</small>
    </motion.div>
    <motion.div className="lp-chip lp-chip-fc" style={{ y: chipsSlow }} aria-hidden="true">
      <span className="lp-chip-from">Prognoză, coada la securitate</span>
      <span className="lp-fc">{[["+30", "9"], ["+60", "12"], ["+90", "8"], ["+120", "5"]].map(([h, v]) => <span key={h}><b>{v}</b><i>{h} min</i></span>)}</span>
      <small>exemplu</small>
    </motion.div>
    <motion.div className="lp-chip lp-chip-exit" style={{ y: chipsFast }} aria-hidden="true">
      <span className="lp-exit-sign">E2</span>
      <span>Ieșirea liberă cea mai apropiată, 40 m în stânga</span>
    </motion.div>

    <div className="lp-runway" aria-hidden="true">
      {LIGHTS.map(i => <span key={i} style={{ animationDelay: `${i * 60}ms` }} />)}
    </div>
  </section>;
}

function Board() {
  return <section className="lp-section lp-board-wrap" id="pasageri" aria-labelledby="lp-board-title">
    <div className="lp-board-head">
      <BlurText text="Pe WhatsApp, pentru zborul tău." className="lp-h2" />
      <p className="lp-lede">Clarion îți scrie doar ce te privește pe tine: când pleci de acasă, cât durează fiecare etapă și pe unde ajungi la poartă.</p>
    </div>
    <div className="lp-board" role="table" aria-label="Ce primești pe WhatsApp">
      <div className="lp-board-row lp-board-th" role="row">
        <span role="columnheader">Mesaj</span><span role="columnheader">Ce afli</span><span role="columnheader">Cum</span>
      </div>
      {BOARD.map((r, i) => <motion.div key={r.code} role="row" className={`lp-board-row${r.alert ? " is-alert" : ""}`}
        initial={{ opacity: 0, x: -24 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, amount: 0.6 }}
        transition={{ type: "spring", bounce: 0, duration: 0.8, delay: i * 0.06 }}>
        <span role="cell" className="lp-board-code"><SplitFlap text={r.code} delay={i * 120} /></span>
        <span role="cell" className="lp-board-text">{r.text}</span>
        <span role="cell" className="lp-board-detail">{r.detail}</span>
      </motion.div>)}
    </div>
  </section>;
}

function Roles() {
  return <section className="lp-section" id="camere" aria-labelledby="lp-roles-title">
    <BlurText text="Camere, angajați și un singur ecran." className="lp-h2 lp-roles-title" />
    <div className="lp-bento">
      <Spotlight className="lp-tile lp-tile-cam">
        <div className="lp-cam" aria-hidden="true">
          <span className="lp-cam-tag">Camera, coada la securitate</span>
          {BOXES.map(([x, y, d], i) => <span key={i} className={`lp-box d${d}`} style={{ left: `${x}%`, top: `${y}%` }}><i /></span>)}
          <span className="lp-cam-count"><b>12</b> persoane, aprox. <b>7</b> min</span>
        </div>
        <h3 id="lp-roles-title">Camerele numără oamenii din cozi.</h3>
        <p>Viziunea pe camere numără persoanele din fiecare coadă, estimează cât se așteaptă acum și face prognoza pentru următoarele 30, 60, 90 și 120 de minute. Doar numărători, fără fețe și fără identități.</p>
      </Spotlight>
      <Spotlight className="lp-tile lp-tile-staff">
        <h3 id="angajati">Angajații raportează pe WhatsApp.</h3>
        <p>Un angajat raportează o problemă din telefon și vede în câte minute ajung echipa de intervenție și poliția aeroportului, ținând cont de aglomerație.</p>
        <ul className="lp-eta" aria-label="Exemplu de timpi de sosire">
          <li><span>Echipa de intervenție</span><b>3 min</b></li>
          <li><span>Poliția aeroportului</span><b>5 min</b></li>
        </ul>
      </Spotlight>
      <Spotlight className="lp-tile lp-tile-admin">
        <h3>Administratorul decide de pe un singur ecran.</h3>
        <p>Un dashboard live cu camerele, cozile, recomandările și evacuarea.</p>
        <div className="lp-advice">
          <span className="lp-advice-rec">Deschide o linie la securitate până la 14:05</span>
          <span className="lp-advice-evac">Evacuare</span>
        </div>
      </Spotlight>
    </div>
  </section>;
}

function Proof() {
  return <section className="lp-section lp-proof" id="rezultate" aria-labelledby="lp-proof-title">
    <BlurText text="Cozi la jumătate. Ieșire mai rapidă." className="lp-h2" />
    <p className="lp-lede" id="lp-proof-title">Simulare, 12 zile pereche, cu și fără Clarion, pe geamănul digital al aeroportului din Craiova.</p>
    <div className="lp-proof-grid">
      {PROOF.map(r => {
        const max = Math.max(r.before, r.after);
        return <div key={r.label} className="lp-metric">
          <h3>{r.label}</h3>
          <p className="lp-metric-note">{r.note}</p>
          <div className="lp-metric-nums">
            <span className="lp-metric-before"><s>{String(r.before).replace(".", ",")}</s> {r.unit}<small>fără Clarion</small></span>
            <span className="lp-metric-after"><CountUp from={r.before} to={r.after} decimals={r.after % 1 ? r.decimals : 0} /> {r.unit}<small>cu Clarion</small></span>
          </div>
          <div className="lp-bars" aria-hidden="true">
            <motion.span className="lp-bar lp-bar-before" initial={{ scaleX: 0 }} whileInView={{ scaleX: r.before / max }} viewport={{ once: true }} transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }} />
            <motion.span className="lp-bar lp-bar-after" initial={{ scaleX: 0 }} whileInView={{ scaleX: r.after / max }} viewport={{ once: true }} transition={{ duration: 1.2, delay: 0.2, ease: [0.16, 1, 0.3, 1] }} />
          </div>
        </div>;
      })}
    </div>
  </section>;
}

function Pass() {
  return <section className="lp-section lp-pass-wrap" aria-labelledby="lp-pass-title">
    <motion.div className="lp-pass" initial={{ opacity: 0, y: 60, rotateX: 18 }} whileInView={{ opacity: 1, y: 0, rotateX: 0 }}
      viewport={{ once: true, amount: 0.4 }} transition={{ type: "spring", bounce: 0.15, duration: 1.1 }}>
      <div className="lp-pass-main">
        <h2 id="lp-pass-title" className="lp-h2">Primește instrucțiunile pentru zborul tău.</h2>
        <p>La abonare te conectezi, îți alegi zborul și primești cardul pentru Wallet și linkul spre WhatsApp cu mesajul START.</p>
        <div className="lp-actions">
          <a className="lp-btn lp-btn-sign" href="/join">Abonează-te</a>
          <a className="lp-btn lp-btn-ghost" href={WHATSAPP_START} target="_blank" rel="noopener noreferrer">Scrie-ne pe WhatsApp</a>
        </div>
      </div>
      <div className="lp-pass-stub" aria-hidden="true">
        <span className="lp-pass-brand">Clarion</span>
        <dl>
          <div><dt>De la</dt><dd>Acasă</dd></div>
          <div><dt>La</dt><dd>Poarta ta</dd></div>
          <div><dt>Aeroport</dt><dd>CRA</dd></div>
        </dl>
        <span className="lp-barcode" />
      </div>
    </motion.div>
  </section>;
}

export default function Landing() {
  return <div className="lp">
    <header className="lp-nav">
      <a href="/" className="lp-brand">Clarion<small>Aeroportul Craiova, LRCV</small></a>
      <nav className="lp-links" aria-label="Secțiuni">
        <a href="#pasageri">Pasageri</a>
        <a href="#camere">Camere și personal</a>
        <a href="#rezultate">Rezultate</a>
      </nav>
      <a className="lp-btn lp-btn-sign lp-btn-sm" href="/join">Abonează-te</a>
    </header>
    <main>
      <Hero />
      <Board />
      <Roles />
      <Proof />
      <Pass />
    </main>
    <footer className="lp-foot">
      <span>Clarion, Aeroportul Internațional Craiova</span>
      <a href="/console">Consola operatorului</a>
    </footer>
  </div>;
}
