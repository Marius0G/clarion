import { dryRun, type Adapter } from "./types.js";
export const whatsapp: Adapter = async (m) => {
  const token = process.env.WA_TOKEN,
    phone = process.env.WA_PHONE_NUMBER_ID,
    version = process.env.WA_API_VERSION;
  if (!token || !phone || !version) return dryRun("whatsapp", m);
  if (!m.destination) return { delivered: false, simulated: false };
  const res = await fetch(
    `https://graph.facebook.com/${version}/${phone}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: m.destination,
        type: "text",
        text: { body: m.text },
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  const body = (await res.json()) as { messages?: { id: string }[] };
  return { delivered: res.ok && !!body.messages?.[0]?.id, simulated: false };
};
