import { beforeEach, describe, expect, it } from 'vitest';
import { Auth, OTP_MS, LINK_MS, SESSION_MS, normalizePhone, type AuthStore } from '../src/auth.js';
let now: number, store: AuthStore, auth: Auth;
beforeEach(() => {
  now = 1000;
  const values = new Map<string, unknown>();
  store = {
    async get<T>(k: string) { return structuredClone(values.get(k)) as T | undefined; },
    async put(k, v) { values.set(k, structuredClone(v)); },
    async delete(k) { return values.delete(k); },
  };
  auth = new Auth(store, () => now);
});
const phone = '+40712345678';
describe('phone ownership', () => {
  it('normalizes RO defaults and international E.164, rejects malformed phones', () => {
    for (const p of ['0712 345 678', '0040 (712) 345-678', '+40712345678']) expect(normalizePhone(p)).toBe(phone);
    expect(normalizePhone('+15556318672')).toBe('+15556318672');
    for (const p of ['', '40712345678', '+012345678', 'abc', null, 712345678, '+1234567890123456']) expect(normalizePhone(p)).toBeNull();
  });
  it('accepts a six-digit OTP once, creates a 32-byte session and revokes logout', async () => {
    const code = await auth.startOtp(phone);
    expect(code).toMatch(/^\d{6}$/);
    const result = await auth.verifyOtp(phone, code);
    expect(result?.session).toMatch(/^[a-f0-9]{64}$/);
    expect(await auth.currentPhone(result!.session)).toBe(phone);
    expect(await auth.verifyOtp(phone, code)).toBeNull();
    await auth.endSession(result!.session);
    expect(await auth.currentPhone(result!.session)).toBeNull();
  });
  it('expires OTPs at five minutes, without extending expiry on mistakes', async () => {
    const code = await auth.startOtp(phone);
    now += OTP_MS - 1;
    await auth.verifyOtp(phone, 'wrong');
    now++;
    expect(await auth.verifyOtp(phone, code)).toBeNull();
  });
  it('allows five total tries, serializes concurrent attempts and throttles resends', async () => {
    const code = await auth.startOtp(phone);
    await expect(auth.startOtp(phone)).rejects.toThrow('Wait');
    const wrong = code === '000000' ? '111111' : '000000';
    await Promise.all(Array.from({ length: 5 }, () => new Auth(store, () => now).verifyOtp(phone, wrong)));
    expect(await auth.verifyOtp(phone, code)).toBeNull();
    now += 60000;
    const next = await auth.startOtp(phone);
    for (let i = 0; i < 4; i++) await auth.verifyOtp(phone, 'wrong');
    expect(await auth.verifyOtp(phone, next)).not.toBeNull();
  });
  it('does not accept another phone’s OTP', async () => {
    const code = await auth.startOtp(phone);
    expect(await auth.verifyOtp('+40700000000', code)).toBeNull();
    expect(await auth.verifyOtp(phone, code)).not.toBeNull();
  });
  it('expires sessions after 90 days and survives another Auth instance', async () => {
    const result = await auth.createSession(phone);
    now += SESSION_MS - 1;
    expect(await new Auth(store, () => now).currentPhone(result.session)).toBe(phone);
    now++;
    expect(await auth.currentPhone(result.session)).toBeNull();
  });
  it('consumes a one-time link atomically and expires it after 15 minutes', async () => {
    const make = () => auth.createLink(phone, 'https://clarion-craiova.pages.dev');
    const url = new URL(await make());
    expect(url.pathname).toBe('/join');
    const token = url.searchParams.get('login');
    const results = await Promise.all([auth.useLink(token), new Auth(store, () => now).useLink(token)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const expired = new URL(await make()).searchParams.get('login');
    now += LINK_MS;
    expect(await auth.useLink(expired)).toBeNull();
  });
  it('binds reverse login only to its first sender and only gives the session to the secret poll token', async () => {
    const pending = await auth.loginCode();
    expect(pending.waLink).toBe(`https://wa.me/15556318672?text=LOGIN%20${pending.code}`);
    expect(await auth.pollLogin(pending.pollToken)).toEqual({ status: 'pending' });
    expect(await auth.pollLogin(pending.code)).toBeNull();
    expect(await auth.bindLogin(pending.code, 'invalid')).toBe(false);
    expect(await auth.bindLogin(pending.code, phone.slice(1))).toBe(true);
    expect(await auth.bindLogin(pending.code, '40799999999')).toBe(false);
    const result = await auth.pollLogin(pending.pollToken);
    expect(result).toMatchObject({ status: 'ok', phone });
    if (result?.status !== 'ok') throw new Error('Expected session');
    expect(await auth.currentPhone(result.session)).toBe(phone);
    expect(await auth.pollLogin(pending.pollToken)).toBeNull();
    expect(await auth.bindLogin(pending.code, phone)).toBe(false);
  });
  it('expires both pending and already-bound reverse logins at five minutes', async () => {
    const a = await auth.loginCode(), b = await auth.loginCode();
    await auth.bindLogin(b.code, phone);
    now += OTP_MS;
    expect(await auth.bindLogin(a.code, phone)).toBe(false);
    expect(await auth.pollLogin(a.pollToken)).toBeNull();
    expect(await auth.pollLogin(b.pollToken)).toBeNull();
  });
});
