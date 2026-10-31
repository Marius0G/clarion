import { useCallback, useEffect, useRef, useState } from "react";
import WalletButton from "./WalletButton";
import QRCode from "qrcode";
import Scanner from "./Scanner";
import type { BoardingFlight } from "./bcbp";
import "./join.css";
import { backend as backendConfig } from "../backend/config";
const backend = backendConfig.http;
const publicBase = import.meta.env.VITE_PUBLIC_URL || window.location.origin;
// Lucide icons (ISC), inlined: plane, plane-landing, car-taxi-front, id-card, siren.
const PLANE = "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z";
const roles = [
  ["passenger_home", "Pasager", "Passenger", PLANE],
  ["relative_arrivals", "Rudă la sosiri", "Meeting someone", "M2 22h20 M3.77 10.77 2 9l2-4.5 1.1.55c.55.28.9.84.9 1.45s.35 1.17.9 1.45L8 8.5l3-6 1.05.53a2 2 0 0 1 1.09 1.52l.72 5.4a2 2 0 0 0 1.09 1.52l4.4 2.2c.42.22.78.55 1.01.96l.6 1.03c.49.88-.06 1.98-1.06 2.1l-1.18.15c-.47.06-.95-.02-1.37-.24L4.29 11.15a2 2 0 0 1-.52-.38Z"],
  ["taxi", "Taxi", "Taxi", "M10 2h4 M21 8l-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8 M7 14h.01 M17 14h.01 M5 10h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z M5 18v2 M19 18v2"],
  ["staff", "Personal aeroport", "Airport staff", "M16 10h2 M16 14h2 M6.17 15a3 3 0 0 1 5.66 0 M11 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"],
  ["isu_smurd", "ISU/SMURD", "ISU/SMURD", "M7 18v-6a5 5 0 1 1 10 0v6 M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z M21 12h1 M18.5 4.5 18 5 M2 12h1 M12 2v1 M4.929 4.929l.707.707 M12 12v6"],
] as const;
function Icon({ d, size = 20 }: { d: string; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}
interface Flight {
  flight: string;
  city?: string;
  sched?: string;
}
function publicJoin() {
  const url = new URL("/join", publicBase);
  if (backendConfig.override) url.searchParams.set("backend", backendConfig.override);
  return url;
}
function Qr({ en }: { en: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  const url = publicJoin();
  url.searchParams.set("src", "jury");
  const target = url.href;
  useEffect(() => {
    if (canvas.current)
      void QRCode.toCanvas(canvas.current, target, {
        width: 560,
        margin: 4,
        errorCorrectionLevel: "M",
        color: { dark: "#102d50", light: "#ffffff" },
      }).catch(() => setError(true));
  }, [target]);
  return (
    <section className="join-qr">
      <h1>
        {en
          ? "Scan. Pick a role. Stay informed."
          : "Scanează. Alege un rol. Află la timp."}
      </h1>
      {error ? (
        <p role="alert">
          {en
            ? "QR unavailable. Use the link below."
            : "QR indisponibil. Folosește linkul de mai jos."}
        </p>
      ) : (
        <canvas
          ref={canvas}
          role="img"
          aria-label={en ? "Subscription QR code" : "Cod QR pentru abonare"}
        />
      )}
      <a href={target}>{target}</a>
      <p>
        {en
          ? "Airport alerts, straight to WhatsApp."
          : "Alerte de la aeroport, direct pe WhatsApp."}
      </p>
    </section>
  );
}
export default function Join() {
  const query = new URLSearchParams(window.location.search);
  const [en, setEn] = useState(query.get("lang") === "en");
  const [role, setRole] = useState<string>(() =>
    roles.some((r) => r[0] === query.get("role")) ? query.get("role")! : "",
  );
  const [flight, setFlight] = useState(query.get("flight") || "");
  const [flights, setFlights] = useState<Flight[]>([]);
  const [consent, setConsent] = useState(false);
  const [scan, setScan] = useState<BoardingFlight | null>(null);
  const [loading, setLoading] = useState(false);
  const [stateError, setStateError] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{ subscriptionId?: string; token?: string; waLink?: string } | null>(
    null,
  );
  const [shareStatus, setShareStatus] = useState("");
  const [copyText, setCopyText] = useState("");
  const submitting = useRef(false);
  const receiveFlight = useCallback((value: BoardingFlight) => {
    setScan(value);
    setFlight(value.flight);
  }, []);
  useEffect(() => {
    document.documentElement.lang = en ? "en" : "ro";
    document.title = "Clarion";
  }, [en]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${backend}/api/state`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("State unavailable");
        const state = await response.json();
        if (Array.isArray(state.flights))
          setFlights(
            state.flights.filter((f: Flight) => typeof f.flight === "string"),
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) setStateError(true);
      });
    return () => controller.abort();
  }, []);
  async function subscribe(event: React.FormEvent) {
    event.preventDefault();
    if (!role || !consent || submitting.current) return;
    submitting.current = true;
    setLoading(true);
    setError("");
    try {
      {
        const response = await fetch(`${backend}/api/join`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flight: flight.trim().toUpperCase() }),
          signal: AbortSignal.timeout(12000),
        });
        if (response.status === 404) throw new Error("unknown-flight");
        if (!response.ok) throw new Error("Join failed");
        const result = await response.json();
        const target = new URL(result.waLink);
        if (target.protocol !== "https:" || target.hostname !== "wa.me" || typeof result.token !== "string")
          throw new Error("Invalid join response");
        setSuccess({ token: result.token, waLink: target.href });
        return;
      }
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === "unknown-flight"
          ? "Zborul nu este în orarul de azi. Verifică numărul și încearcă din nou."
          : en
          ? "Could not subscribe. Please try again."
          : "Abonarea nu a reușit. Încearcă din nou.",
      );
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }
  async function share() {
    const url = publicJoin();
    url.searchParams.set("role", "relative_arrivals");
    url.searchParams.set("flight", flight.trim().toUpperCase());
    const text = en
      ? `Meeting me at Craiova Airport? Follow my flight${flight ? ` ${flight}` : ""} and receive airport updates: ${url.href}`
      : `Mă aștepți la Aeroportul Craiova? Urmărește zborul meu${flight ? ` ${flight}` : ""} și primește actualizări de la aeroport: ${url.href}`;
    try {
      if (navigator.share) {
        try {
          await navigator.share({ title: "Clarion", text });
          return;
        } catch (cause) {
          if (cause instanceof Error && cause.name === "AbortError") return;
        }
      }
      await navigator.clipboard.writeText(text);
      setShareStatus(en ? "Message copied." : "Mesaj copiat.");
    } catch {
      setCopyText(text);
      setShareStatus(
        en ? "Copy the message below." : "Copiază mesajul de mai jos.",
      );
    }
  }
  const t = (ro: string, english: string) => (en ? english : ro);
  return (
    <main className="join-shell">
      <div className="join-page">
        <header className="join-header">
          <a href="/join" className="join-brand">
            Clarion
            <small>Craiova · LRCV</small>
          </a>
          <button
            type="button"
            onClick={() => setEn(!en)}
            aria-label={t("Switch to English", "Schimbă în română")}
          >
            {en ? "RO" : "EN"}
          </button>
        </header>
        {window.location.pathname.replace(/\/$/, "") === "/join/qr" ? (
          <Qr en={en} />
        ) : success ? (
          <section className="join-success" aria-live="polite">
            <div className="join-success-mark">✓</div>
            <h1>{t("Trimite mesajul în WhatsApp.", "Send the message in WhatsApp.")}</h1>
            <p>{t("Apasă Trimite în WhatsApp pentru a activa alertele. Ne scrii primul, apoi putem răspunde în următoarele 24 h.", "Tap Send in WhatsApp to activate alerts. Message us first so we can reply over the next 24 hours.")}</p>
            <a className="join-primary" href={success.waLink} target="_blank" rel="noopener noreferrer">{t("Deschide WhatsApp", "Open WhatsApp")}</a>
            {(success.subscriptionId || success.token) && <WalletButton subscriptionId={success.subscriptionId} joinToken={success.token} />}
            {role.startsWith("passenger") && (
              <button className="join-share" onClick={() => void share()}>
                {t(
                  "Trimite celui care te așteaptă",
                  "Send to whoever is waiting for you",
                )}
              </button>
            )}
            <p role="status">{shareStatus}</p>
            {copyText && (
              <textarea
                aria-label={t("Mesaj de copiat", "Message to copy")}
                readOnly
                value={copyText}
                onFocus={(e) => e.target.select()}
              />
            )}
          </section>
        ) : (
          <>
            <section className="join-intro">
              <div className="join-airport">
                <Icon d={PLANE} size={14} />{" "}
                {t(
                  "Aeroportul Internațional Craiova",
                  "Craiova International Airport",
                )}
              </div>
              <h1>
                {t("Află la timp.", "Know in time.")}
                <br />
                {t("Ajungi când trebuie.", "Arrive when it matters.")}
              </h1>
              <p>
                {t(
                  "Alerte utile pentru zborul tău și oamenii care te așteaptă.",
                  "Useful flight alerts for you and the people waiting for you.",
                )}
              </p>
            </section>
            <form onSubmit={(event) => void subscribe(event)}>
              <fieldset className="join-roles">
                <legend>
                  {t("Tu cum călătorești?", "What brings you here?")}
                </legend>
                <div>
                  {roles.map(([value, ro, english, icon]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={role === value}
                      onClick={() => setRole(value)}
                    >
                      <span aria-hidden="true"><Icon d={icon} /></span>
                      {en ? english : ro}
                      <span className="join-check" aria-hidden="true">
                        {role === value ? "✓" : ""}
                      </span>
                    </button>
                  ))}
                  <button type="button" aria-pressed="true">WhatsApp</button>
                </div>
              </fieldset>
              <div className="join-flight">
                <label htmlFor="join-flight">
                  {t("Număr zbor", "Flight number")}{" "}
                  <small>{channel === "whatsapp" ? t("obligatoriu", "required") : t("opțional", "optional")}</small>
                </label>
                <input
                  id="join-flight"
                  list="join-flights"
                  placeholder="W6 3412"
                  required={channel === "whatsapp"}
                  maxLength={12}
                  pattern="[A-Za-z0-9 ]{2,12}"
                  value={flight}
                  onChange={(e) => {
                    setFlight(e.target.value);
                    setScan(null);
                  }}
                  autoCapitalize="characters"
                  autoComplete="off"
                />
                <datalist id="join-flights">
                  {flights.map((f, i) => (
                    <option key={`${f.flight}-${i}`} value={f.flight}>
                      {f.city}
                      {f.sched ? ` · ${f.sched.slice(0, 10)}` : ""}
                    </option>
                  ))}
                </datalist>
                {stateError && (
                  <p className="join-note">
                    {t(
                      "Orarul nu este disponibil. Scrie numărul zborului.",
                      "Schedule unavailable. Enter your flight number.",
                    )}
                  </p>
                )}
                {scan && (
                  <p className="join-note">
                    {scan.route} · {scan.date} ·{" "}
                    {t(
                      "An dedus. Verifică data:",
                      "Year inferred. Check date:",
                    )}{" "}
                    <input
                      aria-label={t("Data zborului", "Flight date")}
                      type="date"
                      value={scan.date}
                      onChange={(e) =>
                        setScan({ ...scan, date: e.target.value })
                      }
                    />
                  </p>
                )}
                <Scanner en={en} onFlight={receiveFlight} />
              </div>
              <fieldset className="join-channels">
                <legend>
                  {t(
                    "Unde primești alertele?",
                    "Where should alerts reach you?",
                  )}
                </legend>
                <div>
                  <button type="button" aria-pressed="true">WhatsApp</button>
                </div>
              </fieldset>
              <label className="join-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  {t(
                    "Sunt de acord să primesc alerte pe",
                    "I agree to receive alerts on",
                  )}{" "}
                  WhatsApp.{" "}
                  <span>
                    {t(
                      "Boarding pass-ul este citit pe dispozitiv. Pentru WhatsApp trimitem doar zborul. Datele abonării se șterg la 48 h după zbor.",
                      "The boarding pass is read on your device. Only the flight is sent for WhatsApp. Subscription data is deleted 48 h after the flight.",
                    )}
                  </span>
                </span>
              </label>
              {error && (
                <p role="alert" className="join-error">
                  {error}
                </p>
              )}
              <button
                className="join-primary"
                type="submit"
                disabled={!role || !consent || loading}
              >
                {loading
                  ? t("Se conectează…", "Connecting…")
                  : t("Continuă în WhatsApp", "Continue in WhatsApp")}
              </button>
              <p className="join-footer">
                {t(
                  "Fără cont. Doar informația care contează.",
                  "No account. Just the information that matters.",
                )}
              </p>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
