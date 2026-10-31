import SignIn from "./SignIn";
import { authHeaders } from "../backend/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import BoardingPass from "./BoardingPass";
import WalletButton from "./WalletButton";
import QRCode from "qrcode";
import Scanner from "./Scanner";
import type { BoardingFlight } from "./bcbp";
import "./join.css";
import { backend as backendConfig } from "../backend/config";
const backend = backendConfig.http;
const publicBase = import.meta.env.VITE_PUBLIC_URL || window.location.origin;
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
          ? "Scan. Stay informed."
          : "Scanează. Află la timp."}
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
          aria-label={en ? "WhatsApp QR code" : "Cod QR pentru WhatsApp"}
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
  const [flight, setFlight] = useState(query.get("flight") || "");
  const [flights, setFlights] = useState<Flight[]>([]);
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
    if (submitting.current) return;
    if (!flight.trim()) {
      // TODO(join-api): token endpoints currently require a scheduled flight.
      setSuccess({ waLink: "https://wa.me/15556318672?text=START" });
      return;
    }
    submitting.current = true;
    setLoading(true);
    setError("");
    try {
      {
        const response = await fetch(`${backend}/api/join`, {
          method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ flight: flight.trim().toUpperCase(), lang: en ? "en" : "ro" }),
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
          ? t("Zborul nu este în orarul de azi. Verifică numărul și încearcă din nou.", "Flight not in today’s schedule. Check the number and try again.")
          : en
          ? "Could not connect to the flight."
          : "Conectarea la zbor nu a reușit.",
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
            onClick={() => { setEn(!en); setSuccess(null); setError(""); setShareStatus(""); setCopyText(""); }}
            disabled={loading}
            aria-label={t("Switch to English", "Schimbă în română")}
          >
            {en ? "Română / English ✓" : "Română ✓ / English"}
          </button>
        </header>
        <SignIn en={en} onFlight={setFlight} />
        {window.location.pathname.replace(/\/$/, "") === "/join/qr" ? (
          <Qr en={en} />
        ) : success ? (
          <section className="join-success" aria-live="polite">
            <div className="join-success-mark">✓</div>
            <h1>{t("Trimite mesajul în WhatsApp.", "Send the message in WhatsApp.")}</h1>
            <p>{t("Apasă Trimite în WhatsApp pentru a activa alertele. Ne scrii primul, apoi putem răspunde în următoarele 24 h.", "Tap Send in WhatsApp to activate alerts. Message us first so we can reply over the next 24 hours.")}</p>
            <a className="join-primary" href={success.waLink} target="_blank" rel="noopener noreferrer">{t("Deschide WhatsApp", "Open WhatsApp")}</a>
            {(success.subscriptionId || success.token) && <WalletButton en={en} subscriptionId={success.subscriptionId} joinToken={success.token} />}
            {flight && (
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
            <form onSubmit={(event) => void subscribe(event)}>
              <h1>{t("Zborul tău", "Your flight")}</h1>
              <p className="join-note">{t("Opțional. Îl poți adăuga mai târziu în WhatsApp.", "Optional. Add it later in WhatsApp.")}</p>
              <div className="join-flight">
                <Scanner en={en} onFlight={receiveFlight}>
                  <label htmlFor="join-flight">{t("Număr zbor", "Flight number")}</label>
                  <input id="join-flight" list="join-flights" placeholder="W6 3412"
                    maxLength={12} pattern="[A-Za-z0-9 ]{2,12}" value={flight}
                    onChange={(event) => { setFlight(event.target.value); setScan(null); }}
                    autoCapitalize="characters" autoComplete="off" />
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
                </Scanner>
                {flight && <p className="join-note">{t("Zbor", "Flight")} · <strong>{flight}</strong></p>}
                {scan && (
                  <p className="join-note">
                    {scan.route} · {scan.date} ·{" "}
                    {t(
                      "Data:",
                      "Date:",
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
              </div>
              <BoardingPass key={en ? "en" : "ro"} en={en} />
              <p className="join-note">{t("Alertele vin pe WhatsApp după primul mesaj.", "Alerts arrive on WhatsApp after your first message.")}</p>
              {error && (
                <p role="alert" className="join-error">
                  {error}
                </p>
              )}
              <button
                className="join-primary"
                type="submit"
                disabled={loading}
              >
                {loading
                  ? t("Se conectează…", "Connecting…")
                  : t("WhatsApp", "WhatsApp")}
              </button>
              <p className="join-footer">
                {t(
                  "Informații pentru zborul tău.",
                  "Information for your flight.",
                )}
              </p>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
