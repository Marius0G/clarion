import { useRef, useState } from 'react';
import { backend } from '../backend/config';

export interface WalletButtonProps { en?: boolean; subscriptionId?: string; joinToken?: string }

export default function WalletButton({ subscriptionId, joinToken, en = false }: WalletButtonProps) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (busy.current || (!subscriptionId && !joinToken)) return;
    busy.current = true;
    setPending(true);
    setError('');
    // Reserve the tab during the tap so mobile browsers do not block async opens.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const response = await fetch(`${backend.http}/api/wallet/pass`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(joinToken ? { joinToken } : { subscriptionId }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error();
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('saveUrl' in result)
        || typeof result.saveUrl !== 'string' || !('demo' in result) || typeof result.demo !== 'boolean') throw new Error();
      const url = new URL(result.saveUrl, window.location.origin);
      const google = url.origin === 'https://pay.google.com' && url.pathname.startsWith('/gp/v/save/');
      const local = url.origin === window.location.origin && url.pathname === '/join/wallet-demo';
      if (!google && !local) throw new Error();
      if (tab && !tab.closed) tab.location.replace(url.href);
      else window.location.assign(url.href);
    } catch {
      tab?.close();
      setError(en ? 'The pass could not be opened. Try again.' : 'Pass-ul nu a putut fi deschis. Încearcă din nou.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return <div className="clarion-wallet" style={{ colorScheme: 'light', fontFamily: 'Geist, sans-serif' }}>
    <style>{`@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500&display=swap');
      .clarion-wallet button:focus-visible { outline: 3px solid #4285f4; outline-offset: 4px; }
      .clarion-wallet button:hover:not(:disabled) { opacity: .86; }
      .clarion-wallet p { font: 400 13px/1.5 Geist, sans-serif; color: #303030; margin: 12px 0 0; }
    `}</style>
    <button type="button" disabled={pending || (!subscriptionId && !joinToken)} onClick={() => void save()}
      aria-busy={pending} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: 12, minHeight: 48, padding: '12px 20px', border: '1px solid #747775', borderRadius: 24,
        background: '#000', color: '#fff', font: '500 16px/24px Geist, sans-serif',
        cursor: pending ? 'wait' : 'pointer', opacity: pending || (!subscriptionId && !joinToken) ? .6 : 1 }}>
      <svg width="28" height="24" viewBox="0 0 28 24" aria-hidden="true" focusable="false">
        <rect x="2" y="1" width="17" height="16" rx="3" fill="#4285f4" />
        <rect x="7" y="4" width="17" height="16" rx="3" fill="#34a853" />
        <path d="M4 9h20v11a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z" fill="#fbbc04" />
        <path d="M4 9h7v14H7a3 3 0 0 1-3-3Z" fill="#ea4335" />
      </svg>
      {en ? 'Add to Google Wallet' : 'Adaugă în Google Wallet'}
    </button>
    {pending && <p role="status">{en ? 'Preparing pass…' : 'Se pregătește pass-ul…'}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
