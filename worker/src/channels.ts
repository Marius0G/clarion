import { Wallet,type WalletEnv,type WalletStore } from '../../backend/src/wallet.js';
export function createWallet(env: WalletEnv, saved: WalletStore | undefined, persist: (store: WalletStore) => Promise<void>) {
  return new Wallet(env, { saved, persist });
}
export interface Secrets extends WalletEnv {
  WHATSAPP_TOKEN?: string;
  WHATSAPP_WABA_ID?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WA_TOKEN?: string;
  WA_PHONE_NUMBER_ID?: string;
  WA_API_VERSION?: string;
}
export async function validWhatsAppSignature(body: string, header: string | null, secret: string) {
  if (!header || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(header.slice(7).match(/../g)!, hex => parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(body));
}
export async function equalSecret(actual: string | null, expected: string) {
  if (!actual) return false;
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(actual), digest(expected)]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}
