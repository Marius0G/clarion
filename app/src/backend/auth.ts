import { backend } from './config';
export interface Session { session: string; phone: string }
export interface Account { phone: string; role: 'passenger' | 'staff'; flight?: string }
const key = 'clarion.session';
export const sessionToken = () => { try { return localStorage.getItem(key); } catch { return null; } };
export const authHeaders = (): Record<string, string> => { const t = sessionToken(); return t ? { Authorization: `Bearer ${t}` } : {}; };
export const clearSession = () => { try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ } };
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${backend.http}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    ...(body !== undefined && { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(12000),
  });
  if (!response.ok) {
    if (response.status === 401 && path === '/me') clearSession();
    throw new Error(response.status === 410 ? 'Cod expirat. Încearcă din nou.' : 'Conectare nereușită. Verifică datele.');
  }
  return response.json();
}
function save(result: Session) {
  localStorage.setItem(key, result.session);
  return result;
}
// StrictMode can remount an effect: share the single-use exchange, including its result.
const links = new Map<string, Promise<Session>>();
export const auth = {
  me: (signal?: AbortSignal) => request<Account>('/me', undefined, signal),
  loginCode: () => request<{ code: string; waLink: string; pollToken: string }>('/login-code', {}),
  poll: async (token: string, signal?: AbortSignal) => {
    const result = await request<{ status: 'pending' } | ({ status: 'ok' } & Session)>(`/login-code/${token}`, undefined, signal);
    if (result.status === 'ok') save(result);
    return result;
  },
  otp: (phone: string) => request<{ sent: boolean; reason?: string; code?: string }>('/otp', { phone }),
  verify: async (phone: string, code: string) => save(await request<Session>('/verify', { phone, code })),
  link: (token: string) => {
    if (!links.has(token)) links.set(token, request<Session>('/link', { token }).then(save));
    return links.get(token)!;
  },
  logout: async () => { await request('/logout', {}); clearSession(); },
};
