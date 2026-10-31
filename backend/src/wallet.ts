import type { BoardingPass } from './bcbp.js';
import { dryRun,type Delivery,type Outbound } from './channels/types.js';
import type { Engine } from './engine.js';
import type { Client,Envelope,Subscription } from './types.js';

export interface WalletEnv {
  WALLET_PASS_KIND?: 'flight' | 'generic';
  GOOGLE_WALLET_ISSUER_ID?: string;
  GOOGLE_WALLET_SA_EMAIL?: string;
  GOOGLE_WALLET_SA_KEY?: string;
}
export interface WalletStore { passes: string[]; counts: Record<string, number> }
interface Options {
  saved?: WalletStore;
  persist?: (store: WalletStore) => void | Promise<void>;
  fetcher?: typeof fetch;
  now?: () => number;
}
const tokenUrl = 'https://oauth2.googleapis.com/token';
const api = 'https://walletobjects.googleapis.com/walletobjects/v1/genericObject/';
const encoder = new TextEncoder();
function base64url(bytes: Uint8Array) {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const localized = (value: string) => ({ defaultValue: { language: 'ro', value } });
const flightKey = (value?: string) => value?.replace(/\s/g, '').toUpperCase();
const rows = (role: string, flight: string, status: string) => [
  { id: 'role', header: 'Rol', body: role },
  { id: 'flight', header: 'Zbor', body: flight },
  { id: 'status', header: 'Status', body: status },
];

// No Node imports: signing, OAuth, pass creation and event logic run in workerd too.
export class Wallet {
  private passes: Set<string>;
  private counts: Record<string, number>;
  private key?: Promise<CryptoKey>;
  private token?: { value: string; until: number };
  private now: () => number;
  constructor(private env: WalletEnv = {}, private options: Options = {}) {
    this.passes = new Set(options.saved?.passes ?? []);
    this.counts = { ...options.saved?.counts };
    this.now = options.now ?? Date.now;
  }
  async reset() {
    const cleared = { walletPasses: this.passes.size, walletRateLimits: Object.keys(this.counts).length };
    this.passes.clear(); this.counts = {};
    await this.persist();
    return cleared;
  }
  get enabled() {
    return !!(this.env.GOOGLE_WALLET_ISSUER_ID && this.env.GOOGLE_WALLET_SA_EMAIL && this.env.GOOGLE_WALLET_SA_KEY);
  }
  private async persist() {
    await this.options.persist?.({ passes: [...this.passes], counts: { ...this.counts } });
  }
  private objectId(id: string) { return `${this.env.GOOGLE_WALLET_ISSUER_ID}.clarion_${id}`; }
  private async sign(claims: Record<string, unknown>) {
    try {
      this.key ??= crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(
        this.env.GOOGLE_WALLET_SA_KEY!.replace(/\\n/g, '\n')
          .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ''),
      ), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
      const input = `${base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await this.key, encoder.encode(input));
      return `${input}.${base64url(new Uint8Array(signature))}`;
    } catch { throw new Error('Wallet signing failed; check service account configuration'); }
  }
  private active(engine: Engine, id: unknown): Subscription {
    if (typeof id !== 'string') throw new Error('subscriptionId required');
    const sub = engine.subscriptions.find(s => s.id === id && Date.parse(s.expiresAt) > this.now());
    if (!sub) throw new Error('Active subscription required');
    return sub;
  }
  private status(engine: Engine, sub: Subscription) {
    const flight = engine.state.flights.find(f => flightKey(f.flight) === flightKey(sub.flight));
    if (flight?.status === 'diverted') return `SIMULARE · Deviat către ${flight.divertedTo ?? 'alt aeroport'}`;
    if (engine.state.phase === 'suspended') return engine.state.evacuate
      ? 'SIMULARE · Zboruri suspendate; terminal evacuat'
      : 'SIMULARE · Zboruri suspendate; terminalul rămâne deschis';
    if (engine.state.phase === 'recovery') return 'SIMULARE · Reluare în etape; așteaptă instrucțiunile';
    return 'SIMULARE · Operațiuni normale';
  }
  async pass(engine: Engine, subscriptionId: unknown) {
    const sub = this.active(engine, subscriptionId);
    const result = await this.createPass(sub, this.status(engine, sub));
    this.passes.add(sub.id);
    await this.persist();
    return result;
  }
  /** Pending web join: no phone subscription exists until START arrives. */
  async joinPass(id: string, flight: string, expiresAt: string, waLink: string) {
    return this.createPass({ id, flight, expiresAt, role: 'passenger_home' }, 'Deschide WhatsApp pentru alerte', waLink);
  }
  /** Flight data is available for the demo; older subscriptions retain their generic pass. */
  async boardingPass(id: string, pass: BoardingPass, expiresAt: string, waLink: string) {
    if (this.enabled && this.env.WALLET_PASS_KIND !== 'generic') {
      try {
        if (pass.carrier.length !== 2) throw new Error('Flight pass requires an IATA carrier');
        const classId = `${this.env.GOOGLE_WALLET_ISSUER_ID}.clarion_flight_${pass.carrier}${pass.flightNumber}_${pass.localDeparture.slice(0, 10).replace(/-/g, '')}`;
        const jwt = await this.sign({ iss: this.env.GOOGLE_WALLET_SA_EMAIL, aud: 'google',
          typ: 'savetowallet', iat: Math.floor(this.now() / 1000), payload: {
            flightClasses: [{ id: classId, issuerName: 'Clarion', reviewStatus: 'UNDER_REVIEW',
              flightHeader: { carrier: { carrierIataCode: pass.carrier }, flightNumber: pass.flightNumber },
              origin: { airportIataCode: 'CRA' }, destination: { airportIataCode: pass.destination },
              localScheduledDepartureDateTime: pass.localDeparture }],
            flightObjects: [{ id: `${this.env.GOOGLE_WALLET_ISSUER_ID}.clarion_flight_${id}`, classId, state: 'ACTIVE',
              passengerName: pass.passengerName, reservationInfo: { confirmationCode: pass.confirmationCode },
              boardingAndSeatingInfo: { seatNumber: pass.seat, boardingGroup: pass.boardingGroup },
              barcode: { type: 'PDF_417', value: pass.bcbp },
              linksModuleData: { uris: [{ uri: waLink, description: 'Clarion pe WhatsApp' }] },
              textModulesData: [{ id: 'demo', header: 'SIMULARE', body: 'Boarding pass demo · Nu este un bilet de călătorie.' },
                ...(pass.entryTime ? [{ id: 'entry', header: 'Intrare', body: `Ora estimată la intrare: ${pass.entryTime}` }] : [])],
            }],
          } });
        return { saveUrl: `https://pay.google.com/gp/v/save/${jwt}`, demo: false };
      } catch {
        // Local build/sign failure only. Google save-time rejections require WALLET_PASS_KIND=generic.
      }
    }
    return this.joinPass(id, `${pass.carrier} ${pass.flightNumber}`, expiresAt, waLink);
  }
  private async createPass(sub: Pick<Subscription, 'id' | 'flight' | 'expiresAt' | 'role'>, status: string, waLink?: string) {
    let saveUrl = `/join/wallet-demo?sub=${encodeURIComponent(sub.id)}`;
    if (waLink) saveUrl += `&waLink=${encodeURIComponent(waLink)}`;
    if (this.enabled) {
      const classId = `${this.env.GOOGLE_WALLET_ISSUER_ID}.clarion`;
      const jwt = await this.sign({ iss: this.env.GOOGLE_WALLET_SA_EMAIL, aud: 'google',
        typ: 'savetowallet', iat: Math.floor(this.now() / 1000),
        payload: { genericClasses: [{ id: classId }], genericObjects: [{
          id: this.objectId(sub.id), classId, state: 'ACTIVE',
          cardTitle: localized('Clarion · Simulare'), header: localized('Clarion'),
          subheader: localized(sub.flight ?? 'Aeroportul Craiova'), hexBackgroundColor: '#111111',
          textModulesData: rows(sub.role, sub.flight ?? '—', status),
          ...(waLink && { linksModuleData: { uris: [{ uri: waLink, description: 'Deschide WhatsApp' }] },
            barcode: { type: 'QR_CODE', value: waLink } }),
          validTimeInterval: { end: { date: sub.expiresAt } },
        }] },
      });
      saveUrl = `https://pay.google.com/gp/v/save/${jwt}`;
    }
    return { saveUrl, demo: !this.enabled };
  }
  private async accessToken() {
    if (this.token && this.token.until > this.now()) return this.token.value;
    const iat = Math.floor(this.now() / 1000);
    const assertion = await this.sign({ iss: this.env.GOOGLE_WALLET_SA_EMAIL,
      scope: 'https://www.googleapis.com/auth/wallet_object.issuer', aud: tokenUrl, iat, exp: iat + 3600 });
    const response = await this.request(tokenUrl, { method: 'POST', body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
    }) });
    const data = await response.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Wallet OAuth token missing');
    this.token = { value: data.access_token, until: this.now() + (Number(data.expires_in ?? 3600) - 60) * 1000 };
    return this.token.value;
  }
  private async request(url: string, init: RequestInit) {
    try {
      const response = await (this.options.fetcher ?? fetch)(url, { ...init, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      return response;
    } catch { throw new Error('Wallet API request failed'); } // Never expose provider bodies or secrets.
  }
  async send(m: Outbound): Promise<Delivery> {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const key = `${day}:${m.destination ?? 'demo'}`;
    const count = this.counts[key] ?? 0;
    const capped = count >= 3;
    if (capped && !this.enabled) return { delivered: false, simulated: true };
    // Reserve before I/O, including failures, matching the existing attempt counter.
    this.counts = Object.fromEntries(Object.entries(this.counts).filter(([k]) => k.startsWith(`${day}:`)));
    this.counts[key] = capped ? count : count + 1;
    await this.persist();
    if (!this.enabled) return dryRun('wallet', m);
    if (!m.destination) return { delivered: false, simulated: false };
    const headers = { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' };
    const url = `${api}${encodeURIComponent(this.objectId(m.destination))}`;
    await this.request(url, { method: 'PATCH', headers,
      body: JSON.stringify({ textModulesData: rows(m.role, m.values?.flight ?? '—', m.text) }) });
    // Keep status current after the notification budget is exhausted.
    if (capped) return { delivered: false, simulated: false };
    await this.request(`${url}/addMessage`, { method: 'POST', headers,
      body: JSON.stringify({ message: { id: m.messageId, header: 'Clarion · Simulare', body: m.text,
        messageType: 'TEXT_AND_NOTIFY' } }) });
    return { delivered: true, simulated: false };
  }
  async handle(engine: Engine, event: Envelope, client?: Client) {
    await engine.handle(event, client);
  }
}
