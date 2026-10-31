import { useEffect, useRef, useState } from 'react';
import { auth, clearSession, sessionToken, type Account } from '../backend/auth';

export default function SignIn({ onFlight, en = false }: { onFlight: (flight: string) => void; en?: boolean }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [otp, setOtp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<{ code: string; waLink: string; pollToken: string; expires: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const url = new URL(window.location.href);
    const login = url.searchParams.get('login');
    const controller = new AbortController();
    async function restore() {
      try {
        if (login) await auth.link(login);
        if (!mounted.current || (!login && !sessionToken())) return;
        const me = await auth.me(controller.signal);
        setAccount(me);
        if (me.flight) onFlight(me.flight);
      } catch (error) {
        if (!controller.signal.aborted) setMessage(login && error instanceof Error ? error.message : 'Sesiune expirată. Conectează-te din nou.');
      } finally {
        if (login) {
          const clean = new URL(window.location.href);
          clean.searchParams.delete('login');
          window.history.replaceState(window.history.state, '', clean);
        }
      }
    }
    void restore();
    return () => { mounted.current = false; controller.abort(); };
  }, [onFlight]);
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (Date.now() >= pending!.expires) {
        setPending(null); setMessage('Cod expirat. Încearcă din nou.'); return;
      }
      try {
        const result = await auth.poll(pending!.pollToken, controller.signal);
        if (controller.signal.aborted) return;
        if (result.status === 'ok') {
          const me = await auth.me(controller.signal);
          setAccount(me); setPending(null); setMessage('');
          if (me.flight) onFlight(me.flight);
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setPending(null); setMessage(error instanceof Error ? error.message : 'Conexiune indisponibilă.'); return;
      }
      timer = setTimeout(() => void poll(), 2000);
    }
    timer = setTimeout(() => void poll(), 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending, onFlight]);
  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await work(); }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : 'Conectare nereușită.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="join-auth" aria-label="Conectare">
    {account ? <>
      <p>Telefon · {account.phone.slice(0, 3)}•••••{account.phone.slice(-3)}</p>
      {account.flight && <p>Zbor · <strong>{account.flight}</strong></p>}
      <button type="button" disabled={busy} onClick={() => void action(async () => {
        try { await auth.logout(); }
        finally {
          clearSession(); setAccount(null); setPending(null); setOtp(false); setCode(''); setPhone('');
          onFlight('');
        }
      })}>Deconectare</button>
    </> : <>
      <button type="button" className="join-primary" disabled={busy || !!pending} onClick={() => {
        // Open synchronously so mobile browsers do not block the tab after the request.
        const popup = window.open('about:blank', '_blank');
        if (popup) popup.opener = null;
        void action(async () => {
          try {
            const result = await auth.loginCode();
            if (!mounted.current) { popup?.close(); return; }
            setPending({ ...result, expires: Date.now() + 5 * 60000 });
            if (popup) popup.location.href = result.waLink;
          } catch (error) { popup?.close(); throw error; }
        });
      }}>Conectează-te cu WhatsApp</button>
      <p className="join-note">{en ? "Alerts arrive on WhatsApp after your first message." : "Alertele vin pe WhatsApp după primul mesaj."}</p>
      {pending && <div role="status"><p>Așteptăm mesajul…</p><p>Trimite <strong>LOGIN {pending.code}</strong> în WhatsApp.</p>
        <a href={pending.waLink} target="_blank" rel="noopener noreferrer">Deschide WhatsApp</a>
        <button type="button" onClick={() => setPending(null)}>Anulare</button></div>}
      <form onSubmit={event => { event.preventDefault(); setPending(null); void action(async () => {
        if (otp) {
          await auth.verify(phone, code);
          const me = await auth.me(); setAccount(me); setCode('');
          if (me.flight) onFlight(me.flight);
        } else {
          const result = await auth.otp(phone);
          if (result.sent || result.code) {
            setOtp(true);
            if (result.code) setMessage(`Cod demo: ${result.code}`);
          } else setMessage(result.reason === 'window' ? 'Trimite primul mesaj cu butonul WhatsApp de mai sus.' : 'Cod netrimis. Folosește butonul WhatsApp.');
        }
      }); }}>
        <label htmlFor="auth-phone">Telefon</label>
        <input id="auth-phone" type="tel" autoComplete="tel" placeholder="07xx xxx xxx" required maxLength={24} value={phone} disabled={busy || otp} onChange={event => setPhone(event.target.value)} />
        {otp && <><label htmlFor="auth-code">Cod</label><input id="auth-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} /></>}
        <button type="submit" disabled={busy}>{otp ? 'Verifică' : 'Primește cod'}</button>
        {otp && <button type="button" disabled={busy} onClick={() => { setOtp(false); setCode(''); }}>Alt număr</button>}
      </form>
    </>}
    {message && <p role="status" className="join-note">{message}</p>}
    {/* TODO: Google OAuth (openid email profile). */}
  </section>;
}
