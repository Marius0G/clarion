import "./landing.css";

/** Public main page: what Clarion does for passengers, then «Abonează-te» → /join (sign-in, Wallet card, WhatsApp START link). */
const WHATSAPP_START = "https://wa.me/15556318672?text=START";
const TAGLINE = "Clarion transformă aglomerația din aeroport în instrucțiuni personale: când să vii, pe unde să intri și unde să te duci când ceva merge prost.";

const POINTS: readonly [string, string][] = [
  ["Camerele măsoară cozile", "Camerele din terminal numără oamenii la check-in și la securitate și calculează cât se așteaptă acum. Doar numărători, fără fețe și fără identități."],
  ["Pe WhatsApp, pentru zborul tău", "Afli cozile de acum și prognoza pentru momentul în care ajungi, poarta și drumul de la securitate până la ea. Dacă zborul se întârzie sau se anulează, afli imediat."],
  ["Când ceva merge prost", "La o evacuare primești drumul spre cea mai apropiată ieșire liberă, nu spre zona blocată."],
  ["Pentru angajați și administrator", "Angajații raportează o problemă din telefon și văd în câte minute ajung echipa sau poliția aeroportului. Administratorul vede tot terminalul pe un singur ecran și decide: deschide o linie, evacuează o zonă."],
];

export default function Landing() {
  return <div className="landing">
    <div className="landing-page">
      <header className="landing-bar">
        <a href="/" className="landing-brand">Clarion<small>Aeroportul Craiova · LRCV</small></a>
      </header>
      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <p className="landing-eyebrow">Asistent pentru pasageri, pe WhatsApp</p>
          <h1 id="landing-title">{TAGLINE}</h1>
          <div className="landing-actions">
            <a className="landing-primary" href="/join">Abonează-te</a>
            <a className="landing-secondary" href={WHATSAPP_START} target="_blank" rel="noopener noreferrer">Scrie-ne pe WhatsApp</a>
          </div>
          <p className="landing-note">La abonare te conectezi, îți alegi zborul și primești cardul pentru Wallet și linkul spre WhatsApp cu mesajul START.</p>
        </section>
        <section className="landing-what" aria-labelledby="landing-what-title">
          <h2 id="landing-what-title">Ce face Clarion</h2>
          <ol className="landing-points">
            {POINTS.map(([title, text], i) => <li key={title}>
              <span className="landing-num">{String(i + 1).padStart(2, "0")}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>)}
          </ol>
        </section>
      </main>
      <footer className="landing-foot">
        <span>Clarion · Aeroportul Internațional Craiova</span>
        <a href="/console">Consola operatorului</a>
      </footer>
    </div>
  </div>;
}
