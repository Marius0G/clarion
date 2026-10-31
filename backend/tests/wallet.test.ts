import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Wallet, type WalletEnv, type WalletStore } from '../src/wallet.js';
import { Engine } from '../src/engine.js';
import type { Outbound } from '../src/channels/types.js';
import type { Envelope } from '../src/types.js';
let env: WalletEnv;
let publicKey: CryptoKey;
const event = (type: string, data = {}): Envelope => ({ type, ts: new Date().toISOString(), data });
function fixture(options = {}) {
  const engine = new Engine({ wavesEnabled: false, ...options });
  const sub = engine.subscribe({ role: 'relative_arrivals', flight: 'W6 3412', channel: 'telegram', lang: 'ro', consent: true });
  return { engine, sub };
}
function parts(jwt: string) {
  const [header, body, signature] = jwt.split('.') as [string, string, string];
  return { header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    body: JSON.parse(Buffer.from(body, 'base64url').toString()),
    signature: new Uint8Array(Buffer.from(signature, 'base64url')), input: new TextEncoder().encode(`${header}.${body}`) };
}
const message: Outbound = { messageId: 'm', receiptId: 'r', role: 'taxi', lang: 'ro', destination: 'pass1', text: 'SIMULARE · Suspendat', values: { flight: 'W6 3412' } };
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  publicKey = keys.publicKey;
  const pem = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
  env = { GOOGLE_WALLET_ISSUER_ID: '123456', GOOGLE_WALLET_SA_EMAIL: 'wallet@test.invalid', GOOGLE_WALLET_SA_KEY: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----` };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('shared Wallet', () => {
  it('signs a verifiable RS256 save JWT with Clarion class, object and rows', async () => {
    const { engine, sub } = fixture();
    const wallet = new Wallet(env);
    const result = await wallet.pass(engine, sub.id);
    expect(result.demo).toBe(false);
    expect(result.saveUrl).toMatch(/^https:\/\/pay.google.com\/gp\/v\/save\//);
    const jwt = result.saveUrl.split('/save/')[1]!;
    const p = parts(jwt);
    expect(p.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, p.signature, p.input)).toBe(true);
    expect(p.body).toMatchObject({ iss: env.GOOGLE_WALLET_SA_EMAIL, aud: 'google', typ: 'savetowallet', iat: expect.any(Number) });
    const object = p.body.payload.genericObjects[0];
    expect(p.body.payload.genericClasses).toEqual([{ id: object.classId }]);
    expect(object).toMatchObject({ id: `123456.clarion_${sub.id}`, state: 'ACTIVE', header: { defaultValue: { value: 'Clarion' } }, subheader: { defaultValue: { value: sub.flight } } });
    expect(object.textModulesData.map((r: { id: string }) => r.id)).toEqual(['role', 'flight', 'status']);
    const again = parts((await wallet.pass(engine, sub.id)).saveUrl.split('/save/')[1]!);
    expect(again.body.payload.genericObjects[0].id).toBe(object.id);
  });
  it('falls back for missing/partial credentials and rejects absent or expired subscriptions', async () => {
    const { engine, sub } = fixture();
    for (const secrets of [{}, { GOOGLE_WALLET_ISSUER_ID: '123456' }]) {
      const wallet = new Wallet(secrets);
      expect(await wallet.pass(engine, sub.id)).toEqual({ demo: true, saveUrl: `/join/wallet-demo?sub=${sub.id}` });
      await expect(wallet.pass(engine, undefined)).rejects.toThrow('subscriptionId');
      await expect(wallet.pass(engine, 'unknown')).rejects.toThrow('Active subscription');
    }
    sub.expiresAt = new Date(Date.now() - 1).toISOString();
    await expect(new Wallet().pass(engine, sub.id)).rejects.toThrow('Active subscription');
  });
  it('preserves per-pass UTC daily attempts across restarts and resets on the next day', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-31T12:00:00Z');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let saved: WalletStore | undefined;
    let wallet = new Wallet({}, { persist: s => { saved = s; } });
    for (let i = 0; i < 3; i++) await wallet.send(message);
    wallet = new Wallet({}, { saved });
    await wallet.send(message);
    expect(log).toHaveBeenCalledTimes(3);
    await wallet.send({ ...message, destination: 'different-pass' });
    expect(log).toHaveBeenCalledTimes(4);
    vi.setSystemTime('2026-11-01T00:00:00Z');
    await wallet.send(message);
    expect(log).toHaveBeenCalledTimes(5);
  });
  it('uses verifiable OAuth, caches tokens, patches rows and notifies only three times', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).includes('oauth2')
      ? Response.json({ access_token: 'synthetic-token', expires_in: 3600 }) : Response.json({}));
    const wallet = new Wallet(env, { fetcher });
    for (let i = 0; i < 4; i++) await wallet.send(message);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('oauth2'))).toHaveLength(1);
    const assertion = (fetcher.mock.calls[0]![1]!.body as URLSearchParams).get('assertion')!;
    const p = parts(assertion);
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, p.signature, p.input)).toBe(true);
    expect(p.body).toMatchObject({ aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/wallet_object.issuer', exp: p.body.iat + 3600 });
    const patches = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patches).toHaveLength(4);
    expect(JSON.parse(patches[0]![1]!.body as string).textModulesData[2]).toEqual({ id: 'status', header: 'Status', body: message.text });
    const notices = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/addMessage'));
    expect(notices).toHaveLength(3);
    expect(JSON.parse(notices[0]![1]!.body as string).message.messageType).toBe('TEXT_AND_NOTIFY');
    expect(notices[0]![1]!.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
  });
  it('reserves failed attempts and sanitizes signing/provider failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-key-or-provider-secret'));
    let saved: WalletStore | undefined;
    const wallet = new Wallet(env, { fetcher, persist: s => { saved = s; } });
    for (let i = 0; i < 3; i++) await expect(wallet.send(message)).rejects.toThrow('Wallet API request failed');
    expect(Object.values(saved!.counts)).toEqual([3]);
    const { engine, sub } = fixture();
    await expect(new Wallet({ ...env, GOOGLE_WALLET_SA_KEY: 'bad-pem-secret' }).pass(engine, sub.id)).rejects.toThrow('Wallet signing failed');
  });
  it('updates saved passes on confirmation, scopes diversion, and waits for console reopening', async () => {
    const { engine, sub } = fixture();
    const other = engine.subscribe({ role: 'taxi', channel: 'telegram', lang: 'ro', consent: true });
    const wallet = new Wallet();
    await wallet.pass(engine, sub.id);
    await wallet.pass(engine, other.id);
    const send = vi.spyOn(wallet, 'send').mockResolvedValue({ delivered: false, simulated: true });
    await wallet.handle(engine, event('ops.suspended', { reason: 'drone', estimatedReopen: new Date(Date.now() + 600000).toISOString() }), 'twin');
    expect(send).not.toHaveBeenCalled();
    await wallet.handle(engine, event('console.confirm_suspension'), 'console');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toMatchObject({ destination: sub.id, text: expect.stringContaining('suspendate') });
    await wallet.handle(engine, event('flight.diverted', { flight: 'W6 3412', from: 'BGY', to: 'OTP', eta: new Date(Date.now() + 3600000).toISOString() }), 'twin');
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]![0]).toMatchObject({ destination: sub.id, text: expect.stringContaining('OTP') });
    await wallet.handle(engine, event('ops.reopened'), 'twin');
    expect(send).toHaveBeenCalledTimes(3);
    await wallet.handle(engine, event('console.reopen'), 'console');
    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[3]![0].text).toContain('OTP');
    await wallet.handle(engine, event('console.reopen'), 'console');
    expect(send).toHaveBeenCalledTimes(7);
    expect(send.mock.calls[6]![0].text).toContain('normale');
    await wallet.handle(engine, event('console.reset'), 'console');
    expect(send).toHaveBeenCalledTimes(7);
  });
  it('auto-confirm triggers updates while unsaved and expired subscriptions are skipped', async () => {
    const { engine, sub } = fixture({ autoConfirm: true });
    engine.subscribe({ role: 'taxi', channel: 'telegram', lang: 'ro', consent: true });
    const expired = engine.subscribe({ role: 'staff', channel: 'telegram', lang: 'ro', consent: true });
    const wallet = new Wallet();
    await wallet.pass(engine, sub.id);
    await wallet.pass(engine, expired.id);
    expired.expiresAt = new Date(Date.now() - 1).toISOString();
    const send = vi.spyOn(wallet, 'send').mockResolvedValue({ delivered: false, simulated: true });
    await wallet.handle(engine, event('ops.suspended', { reason: 'weather', estimatedReopen: new Date(Date.now() + 600000).toISOString() }), 'twin');
    expect(engine.state.phase).toBe('suspended');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].destination).toBe(sub.id);
  });
});
