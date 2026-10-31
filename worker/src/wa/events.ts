import type { WaStore } from './index.js';

export interface WaEvent {
  at?: string; kind: 'inbound' | 'turn' | 'outbound' | 'send-failure' | 'agent-error' | 'lab-out';
  phone?: string; type?: string; text?: string; tools?: string[]; bubbles?: number; ms?: number;
  ok?: boolean; dryRun?: boolean; status?: number; code?: unknown; explanation?: string;
}
export type Observe = (event: WaEvent) => Promise<void>;
export function metaExplanation(code: unknown) {
  return ({ 131030: "Recipient is not in the test number's allowed list", 131047: '24h messaging window closed; an approved template is required',
    131026: 'Message undeliverable; check the recipient and WhatsApp availability', 190: 'Access token expired or invalid',
    131009: 'Invalid message parameter', 130429: 'Rate limit reached', 131048: 'Spam rate limit reached',
    131049: 'Meta declined delivery to protect engagement', 131051: 'Unsupported message type' } as Record<string, string>)[String(code)] ?? 'WhatsApp delivery failed; inspect the Meta code and HTTP status';
}
/** Mask phone-like strings even when they occur in message/error text. */
export const safeText = (text: string) => text.replace(/\+?\d[\d ()-]{6,}\d/g, p => '•••' + p.replace(/\D/g, '').slice(-3)).slice(0, 200);

/** Writes are serialized: concurrent turns cannot overwrite a newer ring snapshot. */
export class WaEvents {
  private ring?: WaEvent[];
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private store: WaStore) {}
  record: Observe = event => {
    const next = this.chain.then(async () => {
      this.ring ??= await this.store.get<WaEvent[]>('lab:events') ?? [];
      const row = { ...event, at: new Date().toISOString(), ...(event.phone && { phone: event.phone.startsWith('lab-') ? event.phone : '•••' + event.phone.replace(/\D/g, '').slice(-3) }),
        ...(event.text !== undefined && { text: safeText(event.text) }) };
      this.ring = [...this.ring, row].slice(-200);
      await this.store.put('lab:events', this.ring);
    });
    this.chain = next.catch(() => {});
    // Diagnostics must never prevent delivery.
    return next.catch(e => { console.error('WhatsApp event storage failed', String(e)); });
  };
  async list() {
    await this.chain;
    return this.ring ??= await this.store.get<WaEvent[]>('lab:events') ?? [];
  }
}
