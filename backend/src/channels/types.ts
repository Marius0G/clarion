import type { Lang, Role } from "../types.js";
export interface Outbound {
  messageId: string;
  receiptId: string;
  role: Role;
  lang: Lang;
  destination?: string;
  text: string;
}
export interface Delivery {
  delivered: boolean;
  simulated: boolean;
}
export type Adapter = (message: Outbound) => Promise<Delivery>;
export function dryRun(channel: string, m: Outbound): Delivery {
  console.log(
    JSON.stringify({
      channel,
      mode: "dry-run",
      role: m.role,
      messageId: m.messageId,
      text: m.text,
    }),
  );
  return { delivered: false, simulated: true };
}
