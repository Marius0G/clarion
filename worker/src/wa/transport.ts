import { normalizePhone } from '../../../backend/src/auth.js';
export { normalizePhone } from '../../../backend/src/auth.js';
import { metaExplanation, type Observe } from './events.js';
// WhatsApp Cloud API transport, ported from Moni src/whatsapp.js + src/contracts.js (SPEC-v2 D2).
// Without WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID every send is a dry-run log line. Logs never contain message text.

export interface WaEnv {
  APP_URL?: string;
  WHATSAPP_TOKEN?: string; WA_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string; WA_PHONE_NUMBER_ID?: string;
  /** E.164 numbers separated by commas or spaces. Unset = everyone (Meta's test number has its own list). */
  WA_ALLOWLIST?: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  /** Code an employee sends as "STAFF <code>" to get the staff role (D11). Unset: DEFAULT_STAFF_CODE. */
  STAFF_CODE?: string;
  STAFF_PHONES?: string;
}
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// Same Graph version as the template sender (backend/src/channels/whatsapp.ts).
const GRAPH_VERSION = 'v23.0';
/** Between two bubbles, so they arrive in order and read like someone typing. */
export const BUBBLE_PAUSE_MS = 800;

// ---- Reactions (Moni contracts.js): a reply bubble "[react]✈️" goes out as a reaction on the person's message.
export const REACTION = '[react]';
export const react = (emoji: string) => `${REACTION}${emoji}`;
export const isReaction = (bubble: unknown) => String(bubble).startsWith(REACTION);
const EMOJI_HEAD = /^(\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier}|\u{200D}\p{Extended_Pictographic})*)([\s\S]*)$/u;
/** "[react]✈️\nGata" -> { emoji: "✈️", rest: "Gata" }; emoji is null when none follows "[react]". */
export function reactionParts(bubble: string) {
  const body = String(bubble).trim().slice(REACTION.length).trim();
  const head = EMOJI_HEAD.exec(body);
  return { emoji: head?.[1] ?? null, rest: (head ? head[2]! : body).trim() };
}
const LONE_EMOJI = /^\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*$/u;
/** The emoji a reply bubble reacts with, or null for text. */
export function reactionOf(bubble: string) {
  const b = String(bubble).trim();
  return isReaction(b) ? reactionParts(b).emoji : LONE_EMOJI.test(b) ? b : null;
}

/** The instant reaction, before the agent thinks: 👀 a question, 🙏 thanks, ✈️ flight talk, 👋 a hello. */
export function quickReaction(text: string) {
  const t = String(text).toLowerCase();
  if (/\b(thanks|thank you|thx|mersi|merci|ms|mulțumesc|multumesc)\b/.test(t)) return '🙏';
  if (/^\s*(hi|hey|hello|salut|buna|bună|hei)\b/.test(t) && t.length < 25) return '👋';
  if (/\?|\b(how|what|why|where|when|cat|cât|cum|unde|de ce|când|cand|ce)\b/.test(t)) return '👀';
  if (/\b(zbor|avion|poarta|poartă|flight|gate)\b/.test(t)) return '✈️';
  return null;
}

// ---- Inbound parsing.
export const MEDIA = new Set(['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'voice']);
export interface InboundMessage { id: string; phone: string; name: string; type: string; text: string | null; replyId: string | null; at: number }

function textOf(m: any): string | null {
  if (m.type === 'text' || (m.type === undefined && m.text)) return m.text?.body ?? '';
  if (m.type === 'button' || (m.type === undefined && m.button)) return m.button?.text ?? m.button?.payload ?? '';
  if (m.type === 'interactive' || (m.type === undefined && m.interactive)) return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
  return null;
}

/** Meta webhook body -> the messages to answer, oldest first. Statuses and the person's own reactions are dropped. */
export function parseWebhook(payload: any, phoneNumberId?: string): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = change?.value ?? {};
      if (change.field !== undefined && change.field !== 'messages') continue;
      // Another number on the same app is not ours to answer.
      if (phoneNumberId && v.metadata?.phone_number_id !== undefined && String(v.metadata.phone_number_id) !== String(phoneNumberId)) continue;
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const phone = normalizePhone(`+${m?.from}`);
        if (!phone || typeof m.id !== 'string' || m.type === 'reaction') continue;
        const name = v.contacts?.find((c: any) => c.wa_id === m.from)?.profile?.name || '';
        out.push({ id: m.id, phone, name, type: m.type ?? 'text', text: textOf(m), replyId: m.interactive?.button_reply?.id ?? null, at: Number(m.timestamp) * 1000 || Date.now() });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Delivery failures in a status webhook: { phone, code, title }. */
export function failedStatuses(payload: any) {
  const out: { phone: string | null; code: unknown; title: string }[] = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : [])
    for (const change of Array.isArray(entry?.changes) ? entry.changes : [])
      for (const st of Array.isArray(change?.value?.statuses) ? change.value.statuses : []) {
        if (st.status !== 'failed') continue;
        const err = st.errors?.[0] ?? {};
        out.push({ phone: normalizePhone(`+${st.recipient_id}`), code: err.code ?? null, title: String(err.title || err.message || '').slice(0, 120) });
      }
  return out;
}

export function allowed(env: WaEnv, phone: string) {
  const list = String(env.WA_ALLOWLIST || '').split(/[\s,]+/).filter(Boolean);
  return !list.length || list.includes(phone);
}

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};
const validCnp = (c: string) => {
  const k = '279146358279';
  const s = [...k].reduce((acc, w, i) => acc + Number(w) * Number(c[i]), 0) % 11;
  return (s === 10 ? 1 : s) === Number(c[12]);
};
/** What the model must never see: card numbers, CNPs, full IBANs, API keys. */
export function redact(text: string) {
  return String(text)
    .replace(/\bRO\d{2}\s?[A-Z]{4}(?:\s?[A-Z0-9]{4}){4}\b/gi, '[IBAN eliminat]')
    .replace(/\b[1-8]\d{12}\b/g, c => (validCnp(c) ? '[CNP eliminat]' : c))
    .replace(/\b(?:\d[ -]?){13,19}\b/g, m => (luhn(m.replace(/\D/g, '')) ? '[număr de card eliminat]' : m))
    .replace(/\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{32,}\b/g, '[cheie eliminată]');
}

export const masked = (phone: string) => String(phone).replace(/\d(?=\d{3})/g, '•');
const to = (phone: string) => String(phone).replace(/^\+/, '');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Sends to the Graph API. Never throws. */
export class WhatsAppClient {
  constructor(private env: WaEnv, private fetcher: Fetch = (i, init) => fetch(i, init), readonly pause = BUBBLE_PAUSE_MS, private observe?: Observe) {}
  get live() { return Boolean(this.token && this.phoneId); }
  get phoneId() { return this.env.WHATSAPP_PHONE_NUMBER_ID ?? this.env.WA_PHONE_NUMBER_ID; }
  private get token() { return this.env.WHATSAPP_TOKEN ?? this.env.WA_TOKEN; }

  async graph(body: Record<string, unknown>): Promise<{ ok: boolean; dryRun?: boolean; status?: number; code?: unknown }> {
    // Lab identities can never reach Graph, including automatic passenger fan-out.
    if (typeof body.to === 'string' && body.to.startsWith('lab-') && this.token !== 'lab-capture') {
      await this.observe?.({ kind: 'lab-out', phone: body.to, type: String(body.type), text: String((body.text as any)?.body ?? (body.interactive as any)?.body?.text ?? ''), ok: true });
      return { ok: true };
    }
    const result = await this.deliver(body);
    await this.observe?.({ kind: result.ok ? 'outbound' : 'send-failure', phone: body.to ? String(body.to) : undefined,
      type: String(body.type ?? body.status), ...result, ...(!result.ok && { explanation: metaExplanation(result.code) }) });
    return result;
  }
  private async deliver(body: Record<string, unknown>): Promise<{ ok: boolean; dryRun?: boolean; status?: number; code?: unknown }> {
    const type = body.type ?? body.status;
    if (!this.live) {
      console.log(JSON.stringify({ wa: 'dry-run', type, to: body.to ? masked(String(body.to)) : undefined }));
      return { ok: true, dryRun: true };
    }
    try {
      const res = await this.fetcher(`https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { ok: true };
      const err = ((await res.json().catch(() => ({}))) as any).error ?? {};
      console.error(JSON.stringify({ wa: 'send-failed', type, status: res.status, code: err.code }));
      return { ok: false, status: res.status, code: err.code };
    } catch (e) {
      console.error(JSON.stringify({ wa: 'send-failed', type, error: String((e as Error)?.message ?? e) }));
      return { ok: false };
    }
  }
  /** Blue ticks + "typing…"; WhatsApp clears it on our reply or after ~25 s. */
  markReadTyping(messageId: string) {
    return this.graph({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
  }
  // preview_url off: a link preview would open one-time links before the person does.
  sendText(phone: string, body: string) {
    return this.graph({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to(phone), type: 'text', text: { body, preview_url: false } });
  }
  /** Up to 3 reply buttons ({ id, title } with title <= 20 characters); the tap comes back with the id. */
  sendButtons(phone: string, body: string, buttons: { id: string; title: string }[]) {
    return this.graph({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: to(phone), type: 'interactive',
      interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.map(({ id, title }) => ({ type: 'reply', reply: { id, title } })) } },
    });
  }
  sendReaction(phone: string, messageId: string, emoji: string) {
    return this.graph({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to(phone), type: 'reaction', reaction: { message_id: messageId, emoji } });
  }
  /** A pre-approved template: the only thing we may send first outside the 24h window. */
  sendTemplate(phone: string, name: string, params: string[] = [], language = 'ro') {
    return this.graph({
      messaging_product: 'whatsapp', to: to(phone), type: 'template',
      template: { name, language: { code: language }, ...(params.length && { components: [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }] }) },
    });
  }
  /** Replies in order: "[react]✈️" or a lone emoji goes as a reaction on replyTo; text bubbles 800 ms apart. */
  async sendReplies(phone: string, replies: string[], replyTo?: string) {
    let sent = 0, delivered = true;
    for (const bubble of replies) {
      let text = String(bubble).trim();
      let emoji: string | null = null;
      if (isReaction(text)) ({ emoji, rest: text } = reactionParts(text));
      else if (LONE_EMOJI.test(text)) { emoji = text; text = ''; }
      if (emoji && replyTo) await this.sendReaction(phone, replyTo, emoji);
      if (!text) continue;
      for (const part of splitText(text, 4000)) {
        if (sent++) await sleep(this.pause);
        const result = await this.sendText(phone, part);
        delivered &&= result.ok;
      }
    }
    return delivered && sent > 0;
  }
}

/** Text cut into parts of at most max characters, on a paragraph, line or sentence end when there is one. */
export function splitText(text: string, max = 4000) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf('\n\n', max), rest.lastIndexOf('\n', max), rest.lastIndexOf('. ', max) + 1);
    const at = cut > max / 2 ? cut : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
