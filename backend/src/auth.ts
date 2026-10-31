/** Phone ownership uses wall time, independent of the airport simulation clock. */
export interface AuthStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export const OTP_MS = 5 * 60_000;
export const LINK_MS = 15 * 60_000;
export const SESSION_MS = 90 * 86400_000;
type Timed<T> = { value: T; expiresAt: number };
const locks = new WeakMap<AuthStore, Promise<unknown>>();
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let p = input.replace(/[\s().-]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  else if (p.startsWith('0')) p = '+40' + p.slice(1);
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const validToken = (t: unknown): t is string => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);
function digits() {
  // Rejection sampling avoids modulo bias.
  let n: number;
  do { n = crypto.getRandomValues(new Uint32Array(1))[0]!; } while (n >= 4294000000);
  return String(n % 1000000).padStart(6, '0');
}
async function equal(a: string, b: string) {
  const hash = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  const aa = new Uint8Array(x), bb = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}
export class Auth {
  constructor(private store: AuthStore, private now = () => Date.now()) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = (locks.get(this.store) ?? Promise.resolve()).then(work);
    locks.set(this.store, next.catch(() => {}));
    return next;
  }
  private async read<T>(key: string) {
    const item = await this.store.get<Timed<T>>(key);
    if (!item) return;
    if (item.expiresAt <= this.now()) { await this.store.delete(key); return; }
    return item;
  }
  private put<T>(key: string, value: T, ms: number) {
    return this.store.put(key, { value, expiresAt: this.now() + ms });
  }
  private phone(input: unknown) {
    const p = normalizePhone(input);
    if (!p) throw new Error('Invalid phone');
    return p;
  }
  startOtp(input: unknown) {
    return this.serial(async () => {
      const phone = this.phone(input);
      if (await this.read(`auth:cooldown:${phone}`)) throw new Error('Wait before requesting another code');
      const code = digits();
      await this.put(`auth:cooldown:${phone}`, true, 60_000);
      await this.put(`otp:${phone}`, { code, tries: 0 }, OTP_MS);
      return code;
    });
  }
  verifyOtp(input: unknown, code: unknown) {
    return this.serial(async () => {
      const phone = this.phone(input), key = `otp:${phone}`;
      const item = await this.read<{ code: string; tries: number }>(key);
      if (!item) return null;
      const ok = await equal(item.value.code, typeof code === 'string' ? code.trim() : '');
      if (!ok) {
        if (++item.value.tries >= 5) await this.store.delete(key);
        else await this.store.put(key, item); // Failed attempts never extend expiry.
        return null;
      }
      await this.store.delete(key);
      return this.createSession(phone);
    });
  }
  async createSession(input: unknown) {
    const phone = this.phone(input), session = token();
    await this.put(`sid:${session}`, phone, SESSION_MS);
    return { session, phone };
  }
  async currentPhone(session: unknown) {
    return validToken(session) ? (await this.read<string>(`sid:${session}`))?.value ?? null : null;
  }
  async endSession(session: unknown) {
    if (validToken(session)) await this.store.delete(`sid:${session}`);
  }
  async createLink(input: unknown, origin: string) {
    const phone = this.phone(input), t = token();
    await this.put(`link:${t}`, phone, LINK_MS);
    const url = new URL('/join', origin);
    url.searchParams.set('login', t);
    return url.href;
  }
  useLink(t: unknown) {
    return this.serial(async () => {
      if (!validToken(t)) return null;
      const item = await this.read<string>(`link:${t}`);
      if (!item || !await this.store.delete(`link:${t}`)) return null;
      return this.createSession(item.value);
    });
  }
  loginCode() {
    return this.serial(async () => {
      let code: string;
      do { code = token().slice(0, 10).toUpperCase(); } while (await this.read(`login:${code}`));
      const pollToken = token();
      await this.put(`login:${code}`, { pollToken }, OTP_MS);
      await this.put(`poll:${pollToken}`, { code }, OTP_MS);
      return { code, pollToken, waLink: `https://wa.me/15556318672?text=LOGIN%20${code}` };
    });
  }
  bindLogin(code: string, sender: string) {
    return this.serial(async () => {
      if (!/^[A-F0-9]{10}$/.test(code)) return false;
      const phone = normalizePhone(sender.startsWith('+') ? sender : `+${sender}`);
      if (!phone) return false;
      const item = await this.read<{ pollToken: string; phone?: string }>(`login:${code}`);
      if (!item || item.value.phone) return false; // First sender wins; retries cannot replace them.
      item.value.phone = phone;
      await this.store.put(`login:${code}`, item);
      return true;
    });
  }
  pollLogin(t: unknown) {
    return this.serial(async () => {
      if (!validToken(t)) return null;
      const poll = await this.read<{ code: string }>(`poll:${t}`);
      if (!poll) return null;
      const login = await this.read<{ pollToken: string; phone?: string }>(`login:${poll.value.code}`);
      if (!login || login.value.pollToken !== t) return null;
      if (!login.value.phone) return { status: 'pending' as const };
      await this.store.delete(`poll:${t}`);
      await this.store.delete(`login:${poll.value.code}`);
      return { status: 'ok' as const, ...await this.createSession(login.value.phone) };
    });
  }
}
export const bearer = (headers: Headers) => /^Bearer ([a-f0-9]{64})$/.exec(headers.get('Authorization') ?? '')?.[1];
export const parseLogin = (text: string | null) => /^\s*LOGIN\s+([A-F0-9]{10})\s*$/i.exec(text ?? '')?.[1]?.toUpperCase();
// TODO: Google OAuth (openid email profile), after phone login is validated.
