import { useEffect, useRef, useState } from 'react';
import { pdf417 } from 'bwip-js/browser';
import { backend } from '../backend/config';
import { parseBCBP } from './bcbp';

interface Pass { bcbp: string; token: string; waLink: string; walletUrl: string }
export default function BoardingPass({ en = false }: { en?: boolean }) {
  const [pass, setPass] = useState<Pass | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!pass || !canvas.current) return;
    const options = { bcid: 'pdf417', text: pass.bcbp, scale: 3,
      columns: 5, eclevel: 4, padding: 12, backgroundcolor: 'FFFFFF' };
    pdf417(canvas.current, options);
  }, [pass]);
  async function create() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${backend.http}/api/join/demo`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: en ? 'en' : 'ro' }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error();
      const data: Pass = await response.json();
      if (typeof data.bcbp !== 'string' || !parseBCBP(data.bcbp) || typeof data.token !== 'string' ||
        typeof data.waLink !== 'string' || typeof data.walletUrl !== 'string') throw new Error();
      const wa = new URL(data.waLink);
      const wallet = new URL(data.walletUrl, window.location.origin);
      if (wa.origin !== 'https://wa.me' || !((wallet.origin === 'https://pay.google.com' && wallet.pathname.startsWith('/gp/v/save/')) ||
        (wallet.origin === window.location.origin && wallet.pathname === '/join/wallet-demo'))) throw new Error();
      setPass(data);
    } catch {
      setError(en ? 'Boarding pass unavailable. Try again.' : 'Boarding pass indisponibil. Încearcă din nou.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const flight = pass && parseBCBP(pass.bcbp);
  return <section className="join-boarding-pass" aria-label="Boarding pass">
    <button type="button" className="join-scan" disabled={busy} onClick={() => void create()}>
      {busy ? (en ? 'Preparing…' : 'Se pregătește…') : 'Boarding pass'}
    </button>
    {error && <p role="alert">{error}</p>}
    {pass && flight && <div aria-live="polite">
      <h2>Boarding pass</h2>
      <p><strong>{pass.bcbp.slice(2, 22).trim()}</strong><br />
        {flight.flight} · {flight.route} · {flight.date}<br />{en ? 'Seat:' : 'Loc:'} {pass.bcbp.slice(48, 52).replace(/^0+/, '')}</p>
      <canvas ref={canvas} role="img" aria-label={en ? 'Boarding pass PDF417 barcode' : 'Cod de bare PDF417 boarding pass'} />
      <p>{en ? 'Scan this code from another phone using the Clarion scanner.' : 'Scanează codul de pe alt telefon cu scannerul Clarion.'}</p>
      <a className="join-primary" href={pass.walletUrl} target="_blank" rel="noopener noreferrer">{en ? 'Add to Google Wallet' : 'Adaugă în Google Wallet'}</a>
      <a className="join-primary" href={pass.waLink} target="_blank" rel="noopener noreferrer">{en ? 'Open WhatsApp' : 'Deschide WhatsApp'}</a>
    </div>}
  </section>;
}
