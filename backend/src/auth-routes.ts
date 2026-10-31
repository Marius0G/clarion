import { Auth, bearer, normalizePhone } from './auth.js';
export interface AuthEnv { STAFF_PHONES?: string; DEMO_OTP?: string }
export interface AuthRoutes {
  auth: Auth;
  env: AuthEnv;
  profile(phone: string): Promise<{ role?: string; flight?: string } | undefined>;
  withinWindow(phone: string): Promise<boolean>;
  sendOtp(phone: string, code: string): Promise<boolean>;
}
/** Both HTTP runtimes use these routes and response shapes. */
export async function authRoute(request: Request, deps: AuthRoutes): Promise<Response> {
  const path = new URL(request.url).pathname;
  const { auth } = deps;
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  try {
    if (request.method === 'GET' && path === '/api/auth/me') {
      const phone = await auth.currentPhone(bearer(request.headers));
      if (!phone) return json({ error: 'Session required' }, 401);
      const profile = await deps.profile(phone);
      const staff = (deps.env.STAFF_PHONES ?? '').split(',').some(p => normalizePhone(p.trim()) === phone);
      return json({ phone, role: staff || profile?.role === 'staff' ? 'staff' : 'passenger', ...(profile?.flight && { flight: profile.flight }) });
    }
    const poll = /^\/api\/auth\/login-code\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && poll) {
      const result = await auth.pollLogin(poll[1]);
      return result ? json(result) : json({ error: 'Code expired or consumed' }, 410);
    }
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (path === '/api/auth/login-code') return json(await auth.loginCode());
    if (path === '/api/auth/logout') { await auth.endSession(bearer(request.headers)); return json({ ok: true }); }
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: 'Body too large' }, 413);
    const input = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'JSON object required' }, 400);
    if (path === '/api/auth/otp') {
      const phone = normalizePhone(input.phone);
      if (!phone) return json({ error: 'Invalid phone' }, 400);
      const window = await deps.withinWindow(phone);
      if (!window && deps.env.DEMO_OTP !== '1') return json({ sent: false, reason: 'window' });
      const code = await auth.startOtp(phone);
      if (!window) return json({ sent: false, reason: 'window', code });
      const sent = await deps.sendOtp(phone, code);
      return json({ sent, ...(!sent && { reason: 'delivery' }), ...(deps.env.DEMO_OTP === '1' && { code }) });
    }
    const result = path === '/api/auth/verify' ? await auth.verifyOtp(input.phone, input.code)
      : path === '/api/auth/link' ? await auth.useLink(input.token) : undefined;
    if (result === undefined) return json({ error: 'Not found' }, 404);
    return result ? json(result) : json({ error: 'Invalid or expired code' }, 401);
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Invalid request' }, 400); }
}
