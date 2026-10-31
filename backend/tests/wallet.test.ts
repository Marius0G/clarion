import { afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import type { Outbound } from '../src/channels/types.js';
import { Engine } from '../src/engine.js';
import type { Envelope } from '../src/types.js';
import { Wallet,type WalletEnv,type WalletStore } from '../src/wallet.js';
let env: WalletEnv;
let publicKey: CryptoKey;
const event = (type: string, data = {}): Envelope => ({ type, ts: new Date().toISOString(), data });
function fixture(options = {}) {
  const engine = new Engine({ ...options });
  const sub = engine.subscribe({ role: 'relative_arrivals', flight: 'W6 3412', channel: 'whatsapp', lang: 'ro', consent: true });
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
  it('puts the same START link in the pending join pass link module and QR', async () => {
    const link = 'https://wa.me/15556318672?text=START%20W6%203751%20abcd';
    const result = await new Wallet(env).joinPass('abcd', 'W6 3751', '2026-11-01T12:00:00Z', link);
    const object = parts(result.saveUrl.split('/save/')[1]!).body.payload.genericObjects[0];
    expect(object.linksModuleData.uris).toEqual([{ uri: link, description: 'Deschide WhatsApp' }]);
    expect(object.barcode).toEqual({ type: 'QR_CODE', value: link });
    expect(object.subheader.defaultValue.value).toBe('W6 3751');
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
});

it('signs the documented flight class/object with the BCBP and WhatsApp link', async () => {
  const { demoBoardingPass } = await import('../src/bcbp.js');
  const pass = demoBoardingPass({ flight: 'W6 3751', destination: 'LTN', localDeparture: '2026-10-31T09:40:00', entryTime: '08:10' });
  const link = 'https://wa.me/15556318672?text=START';
  const result = await new Wallet(env).boardingPass('demo', pass, '2026-11-01T12:00:00Z', link);
  const p = parts(result.saveUrl.split('/save/')[1]!);
  expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, p.signature, p.input)).toBe(true);
  expect(p.body.payload).toEqual({ flightClasses: [{ id: '123456.clarion_flight_W63751_20261031', issuerName: 'Clarion', reviewStatus: 'UNDER_REVIEW',
    flightHeader: { carrier: { carrierIataCode: 'W6' }, flightNumber: '3751' }, origin: { airportIataCode: 'CRA' },
    destination: { airportIataCode: 'LTN' }, localScheduledDepartureDateTime: '2026-10-31T09:40:00' }],
    flightObjects: [{ id: '123456.clarion_flight_demo', classId: '123456.clarion_flight_W63751_20261031', state: 'ACTIVE',
      passengerName: 'POPESCU/ION', reservationInfo: { confirmationCode: 'ABC123' }, boardingAndSeatingInfo: { seatNumber: '12A', boardingGroup: '1' },
      barcode: { type: 'PDF_417', value: pass.bcbp }, linksModuleData: { uris: [{ uri: link, description: 'Clarion pe WhatsApp' }] },
      textModulesData: [{ id: 'demo', header: 'SIMULARE', body: 'Boarding pass demo · Nu este un bilet de călătorie.' },
        { id: 'entry', header: 'Intrare', body: 'Fii la intrare la 08:10' }] }] });
});
it('uses generic on explicit opt-out or a flight signing failure', async () => {
  const { demoBoardingPass } = await import('../src/bcbp.js');
  const pass = demoBoardingPass({ flight: 'W6 3751', destination: 'LTN', localDeparture: '2026-10-31T09:40:00' });
  for (const forced of [true, false]) {
    const wallet = new Wallet({ ...env, ...(forced && { WALLET_PASS_KIND: 'generic' as const }) });
    if (!forced) vi.spyOn(wallet as unknown as { sign: (claims: Record<string, unknown>) => Promise<string> }, 'sign').mockRejectedValueOnce(new Error('flight failed'));
    const result = await wallet.boardingPass('demo', pass, '2026-11-01T12:00:00Z', 'https://wa.me/123');
    const payload = parts(result.saveUrl.split('/save/')[1]!).body.payload;
    expect(payload.genericObjects[0].classId).toBe('123456.clarion');
    expect(payload.flightClasses).toBeUndefined();
  }
});
