import type { Lang,Role } from "../types.js";
import { environment } from "./env.js";
import { dryRun,type Adapter,type Outbound } from "./types.js";
import { catalog } from "./whatsapp-catalog.js";
export { catalog };
export function selectTemplate(role: Role, situation: Outbound["situation"], lang: Lang) {
  const name = situation === "subscribe" ? "abonare_confirmata" : situation === "evacuation" ? "evacuare_terminal" : undefined;
  const template = catalog.templates.find(t => t.name === name);
  const content = template && (template.languages as Partial<Record<Lang, {body: string; buttons: readonly string[]}>>)[lang];
  return template && content ? { name: template.name, language: lang, ...content } : undefined;
}
export function fillTemplate(template: NonNullable<ReturnType<typeof selectTemplate>>, values: Record<string, string>) {
  const parameters: { type: "text"; parameter_name: string; text: string }[] = [];
  const text = template.body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (!value || /\{\{/.test(value)) throw new Error(`Missing WhatsApp parameter: ${key}`);
    parameters.push({ type: "text", parameter_name: key, text: value });
    return value;
  });
  return { text, parameters };
}
export function whatsappPayload(m: Outbound, now = Date.now()) {
  const template = selectTemplate(m.role, m.situation, m.lang);
  const filled = template ? fillTemplate(template, m.values ?? {}) : undefined;
  const base = { messaging_product: "whatsapp", to: m.destination };
  const elapsed = now - Date.parse(m.lastInboundAt ?? "");
  if (elapsed >= 0 && elapsed < 86400000) return { ...base, type: "text", text: { body: filled?.text ?? m.text } };
  if (!template || !filled) return undefined;
  return { ...base, type: "template", template: { name: template.name, language: { code: m.lang }, components: [
    ...(filled.parameters.length ? [{ type: "body", parameters: filled.parameters }] : []),
    ...template.buttons.map((text, i) => ({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: text }] })),
  ] } };
}
export interface WhatsAppEnv { WHATSAPP_TOKEN?: string; WHATSAPP_PHONE_NUMBER_ID?: string; WHATSAPP_VERIFY_TOKEN?: string }
export function createWhatsApp(env: WhatsAppEnv, fetcher: typeof fetch = fetch): Adapter {
  return async m => {
    if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return dryRun("whatsapp", m);
    if (!m.destination) return { delivered: false, simulated: false };
    const payload = whatsappPayload(m);
    if (!payload) {
      console.warn(`Clarion WhatsApp: no ${m.lang} template for ${m.role}/${m.situation}; requires an inbound message.`);
      return { delivered: false, simulated: false };
    }
    const res = await fetcher(`https://graph.facebook.com/v23.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
    const body = await res.json() as { messages?: {id: string}[] };
    // Provider acceptance is tracked by ID; handset delivery comes only from webhook.
    return { delivered: false, simulated: false, providerId: res.ok ? body.messages?.[0]?.id : undefined };
  };
}
export const whatsapp: Adapter = m => createWhatsApp(environment())(m);
export function verifyWhatsApp(query: URLSearchParams, token?: string): string | undefined {
  return token && query.get("hub.mode") === "subscribe" && query.get("hub.verify_token") === token ? query.get("hub.challenge") ?? undefined : undefined;
}
export type WhatsAppEvent = { kind: "status"; id: string; status: "sent" | "delivered" | "read"; destination?: string; at?: string } | { kind: "message"; id: string; destination: string; text: string; contextId?: string; at?: string };
// Pure parser: one notification can contain multiple entries, changes, statuses and messages.
export function parseWhatsAppWebhook(body: any): WhatsAppEvent[] {
  const events: WhatsAppEvent[] = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) for (const change of Array.isArray(entry?.changes) ? entry?.changes : []) {
    const value = change?.value;
    for (const s of Array.isArray(value?.statuses) ? value.statuses : []) if (typeof s?.id === "string" && ["sent", "delivered", "read"].includes(s.status)) events.push({ kind: "status", id: s.id, status: s.status, destination: s.recipient_id, at: timestamp(s.timestamp) });
    for (const m of Array.isArray(value?.messages) ? value.messages : []) {
      const text = m?.text?.body ?? m?.button?.text ?? m?.interactive?.button_reply?.title ?? m?.interactive?.button_reply?.id;
      if (typeof m?.id === "string" && typeof m.from === "string" && typeof text === "string") events.push({kind: "message", id: m.id, destination: m.from, text, contextId: m.context?.id, at: timestamp(m.timestamp)});
    }
  }
  return events;
}
function timestamp(value: unknown) { const n = Number(value); return Number.isFinite(n) && n > 0 && n < 8640000000000 ? new Date(n * 1000).toISOString() : undefined; }
export function parseStartCode(text: string): {role: Role; flight?: string; lang: Lang} | undefined {
  const normalized = text.trim().toUpperCase();
  if (!/^(START\s+|CLARION\s+)/.test(normalized)) return;
  const code = normalized.replace(/^START\s+/, "").replace(/^CLARION\s+/, "");
  const [raw, ...rest] = code.split(/\s+|__/);
  const aliases: Record<string, Role> = { PASAGER: "passenger_home", PASSENGER: "passenger_home", ASTEPTARE: "relative_arrivals", RELATIVE: "relative_arrivals", TAXI: "taxi", PERSONAL: "staff", STAFF: "staff", BOLT: "rideshare" };
  const role = aliases[raw!] ?? raw?.toLowerCase();
  if (!role || !["passenger_home","passenger_road","passenger_terminal","relative_arrivals","taxi","rideshare","staff","isu_smurd","alt_airport","public","rent_a_car_ubt"].includes(role)) return;
  const flight = rest.join("").replace(/EN$/, "");
  if (flight && !/^[A-Z0-9]{3,10}$/.test(flight)) return;
  return { role: role as Role, flight: flight || undefined, lang: /\bEN$/.test(normalized) ? "en" : "ro" };
}
// Texts are sourced from the submitted catalog, including translations.
export function buttonAction(text: string): "home" | "road" | "terminal" | "kerb" | "unknown" | "unsubscribe" | "read" | undefined {
  const places: Record<string, "home" | "road" | "terminal"> = { "Sunt pe drum": "road", "Plec acum": "road", "I am on my way": "road", "Sunt în terminal": "terminal", "I am in the terminal": "terminal", "Nu am plecat încă": "home", "I have not left yet": "home" };
  if (places[text]) return places[text];
  for (const t of catalog.templates) for (const [lang, content] of Object.entries(t.languages)) {
    const i = (content.buttons as readonly string[]).indexOf(text);
    if (i < 0) continue;
    if (t.name === "abonare_confirmata") return "unsubscribe";
    if (t.name === "evacuare_terminal") return (["kerb", "terminal", "unknown"] as const)[i];
    void lang;
    return "read";
  }
}
