import { dryRun, type Adapter } from '../../backend/src/channels/types.js';
export interface Secrets {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_TAXI_GROUP_ID?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_WABA_ID?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WA_TOKEN?: string;
  WA_PHONE_NUMBER_ID?: string;
  WA_API_VERSION?: string;
  SMSLINK_CONNECTION_ID?: string;
  SMSLINK_PASSWORD?: string;
}
// The Node SMS adapter reads process.env. Keep this transport-only adapter here;
// state, templates, receipts and metrics remain owned by the shared engine.
export function createSms(env: Secrets): Adapter {
  return async m => {
    if (/https?:\/\/|www\./i.test(m.text)) throw new Error('SMS must not contain links');
    if (!env.SMSLINK_CONNECTION_ID || !env.SMSLINK_PASSWORD) return dryRun('sms', m);
    if (!m.destination) return { delivered: false, simulated: false };
    const response = await fetch('https://secure.smslink.ro/sms/gateway/communicate/index.php', {
      method: 'POST',
      body: new URLSearchParams({ connection_id: env.SMSLINK_CONNECTION_ID,
        password: env.SMSLINK_PASSWORD, to: m.destination, message: m.text }),
      signal: AbortSignal.timeout(10000),
    });
    return { delivered: response.ok && /^MESSAGE;1;/.test((await response.text()).trim()), simulated: false };
  };
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
