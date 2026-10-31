import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import Scanner from "./Scanner";
import type { BoardingFlight } from "./bcbp";
import "./join.css";
const backend = (
  import.meta.env.VITE_BACKEND_HTTP || "http://localhost:8787"
).replace(/\/$/, "");
const publicBase = import.meta.env.VITE_PUBLIC_URL || window.location.origin;
const roles = [
  ["passenger_home", "Pasager", "Passenger", "✈"],
  ["relative_arrivals", "Rudă la sosiri", "Meeting someone", "↘"],
  ["taxi", "Taxi", "Taxi", "T"],
  ["staff", "Personal aeroport", "Airport staff", "▦"],
  ["isu_smurd", "ISU/SMURD", "ISU/SMURD", "+"],
] as const;
interface Flight {
  flight: string;
  city?: string;
  sched?: string;
}
type Channel = "telegram" | "sms" | "whatsapp";
function publicJoin() {
  return new URL("/join", publicBase);
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
          ? "Airport alerts, straight to Telegram."
          : "Alerte de la aeroport, direct pe Telegram."}
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
  const [channel, setChannel] = useState<Channel>("telegram");
  const [enabled, setEnabled] = useState<Record<Channel, boolean>>({
    telegram: true,
    sms: false,
    whatsapp: false,
  });
  const [consent, setConsent] = useState(false);
  const [destination, setDestination] = useState("");
  const [scan, setScan] = useState<BoardingFlight | null>(null);
  const [loading, setLoading] = useState(false);
  const [stateError, setStateError] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<{ telegramLink?: string } | null>(
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
    document.title = en ? "Join · CONTROL TOWER" : "Abonare · CONTROL TOWER";
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
        // Explicit opt-in capability shape; absent flags always leave paid adapters off.
        const flags = state.channels;
        if (flags && typeof flags === "object" && !Array.isArray(flags))
          setEnabled({
            telegram: true,
            sms: flags.sms === true || flags.sms?.enabled === true,
            whatsapp:
              flags.whatsapp === true || flags.whatsapp?.enabled === true,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) setStateError(true);
      });
    return () => controller.abort();
  }, []);
  async function subscribe(event: React.FormEvent) {
    event.preventDefault();
    if (!role || !consent || submitting.current || !enabled[channel]) return;
    submitting.current = true;
    setLoading(true);
    setError("");
    // Reserve a tab during the user gesture; keep the share screen on this phone.
    const telegramTab =
      channel === "telegram" ? window.open("about:blank", "_blank") : null;
    if (telegramTab) telegramTab.opener = null;
    try {
      const response = await fetch(`${backend}/api/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          ...(flight.trim() ? { flight: flight.trim().toUpperCase() } : {}),
          ...(scan?.date ? { date: scan.date } : {}),
          ...(channel !== "telegram" ? { destination } : {}),
          channel,
          lang: en ? "en" : "ro",
          consent: true,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error("Subscribe failed");
      const result = await response.json();
      if (!result.subscriptionId) throw new Error("Invalid response");
      let link: string | undefined;
      if (result.telegramLink) {
        const target = new URL(result.telegramLink);
        if (target.protocol !== "https:" || target.hostname !== "t.me")
          throw new Error("Invalid Telegram link");
        link = target.href;
      }
      setSuccess({ telegramLink: link });
      if (link && telegramTab) telegramTab.location.replace(link);
      else telegramTab?.close();
    } catch {
      telegramTab?.close();
      setError(
        en
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
          await navigator.share({ title: "CONTROL TOWER", text });
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
            <span aria-hidden="true">⌁</span> CONTROL TOWER
            <small>Craiova · CRA</small>
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
            <h1>
              {channel === "telegram"
                ? t("Mai ai un pas.", "One more step.")
                : t("Cerere înregistrată.", "Request registered.")}
            </h1>
            <p>
              {channel === "telegram"
                ? t(
                    "În Telegram, apasă Start pentru a activa alertele.",
                    "In Telegram, tap Start to activate alerts.",
                  )
                : t(
                    "Preferințele tale au fost înregistrate.",
                    "Your preferences have been saved.",
                  )}
            </p>
            {success.telegramLink ? (
              <a className="join-primary" href={success.telegramLink}>
                {t("Deschide Telegram", "Open Telegram")}
              </a>
            ) : (
              channel === "telegram" && (
                <p role="alert">
                  {t(
                    "Botul Telegram nu este configurat. Cere echipei linkul de activare.",
                    "The Telegram bot is not configured. Ask the team for the activation link.",
                  )}
                </p>
              )
            )}
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
                <span aria-hidden="true">✈</span>{" "}
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
                      <span aria-hidden="true">{icon}</span>
                      {en ? english : ro}
                      <span className="join-check" aria-hidden="true">
                        {role === value ? "✓" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <div className="join-flight">
                <label htmlFor="join-flight">
                  {t("Număr zbor", "Flight number")}{" "}
                  <small>{t("opțional", "optional")}</small>
                </label>
                <input
                  id="join-flight"
                  list="join-flights"
                  placeholder="W6 3412"
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
                      "Orarul nu este disponibil. Poți scrie zborul sau continua fără el.",
                      "Schedule unavailable. Enter a flight or continue without one.",
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
                  {(["telegram", "sms", "whatsapp"] as const).map((value) => (
                    <button
                      type="button"
                      key={value}
                      disabled={!enabled[value]}
                      aria-pressed={channel === value}
                      onClick={() => {
                        setChannel(value);
                        setConsent(false);
                      }}
                    >
                      {value === "telegram"
                        ? "Telegram"
                        : value === "sms"
                          ? "SMS"
                          : "WhatsApp"}
                      {!enabled[value] && (
                        <small>{t("în curând", "coming soon")}</small>
                      )}
                    </button>
                  ))}
                </div>
              </fieldset>
              {channel !== "telegram" && (
                <div className="join-flight">
                  <label htmlFor="join-phone">
                    {t(
                      "Număr de telefon cu prefix",
                      "Phone number with country code",
                    )}
                  </label>
                  <input
                    id="join-phone"
                    type="tel"
                    autoComplete="tel"
                    placeholder="+407xxxxxxxx"
                    pattern="[+][1-9][0-9]{7,14}"
                    required
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  />
                </div>
              )}
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
                  {channel === "telegram"
                    ? "Telegram"
                    : channel === "sms"
                      ? "SMS"
                      : "WhatsApp"}
                  .{" "}
                  <span>
                    {t(
                      "Din boarding pass păstrăm doar zborul, data și ruta. Datele abonării se șterg la 48 h după zbor.",
                      "From the boarding pass we keep only flight, date and route. Subscription data is deleted 48 h after the flight.",
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
                  : channel === "telegram"
                    ? t("Continuă în Telegram", "Continue in Telegram")
                    : t("Abonează-mă", "Subscribe")}
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
