import { expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { authRoute, type AuthRoutes } from '../src/auth-routes.js';
function deps(env = {}): AuthRoutes {
  const store = new Map<string, unknown>();
  return { auth: new Auth({
    async get<T>(key: string) { return structuredClone(store.get(key)) as T | undefined; },
    async put(key, value) { store.set(key, structuredClone(value)); },
    async delete(key) { return store.delete(key); },
  }), env, profile: async () => undefined, withinWindow: async () => false, sendOtp: async () => { throw new Error('must not send outside window'); } };
}
const request = (path: string, body: unknown) => new Request(`https://example.com/api/auth${path}`, { method: 'POST', body: JSON.stringify(body) });
it('exposes the OTP only with the explicit development flag, including offline testing', async () => {
  const normal = deps();
  expect(await (await authRoute(request('/otp', { phone: '0712345678' }), normal)).json()).toEqual({ sent: false, reason: 'window' });
  expect((await authRoute(request('/verify', { phone: '0712345678', code: '000000' }), normal)).status).toBe(401);
  const demo = deps({ DEMO_OTP: '1' });
  const response = await (await authRoute(request('/otp', { phone: '0712345678' }), demo)).json();
  expect(response).toMatchObject({ sent: false, reason: 'window' });
  expect(response.code).toMatch(/^\d{6}$/);
  expect((await authRoute(request('/verify', { phone: '0712345678', code: response.code }), demo)).status).toBe(200);
});
it('returns JSON for malformed auth input', async () => {
  for (const value of [null, [], 'invalid']) expect((await authRoute(request('/verify', value), deps())).status).toBe(400);
});
