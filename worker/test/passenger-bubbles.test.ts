import { expect, it } from 'vitest';
import { passengerBubbles, WhatsAppClient } from '../src/wa/transport.js';
it('keeps short bubbles, sentence boundaries, URLs and complete content', () => {
  const text = 'Securitate: 12 min acum. '.repeat(12).trim();
  const parts = passengerBubbles(text);
  expect(parts.every(p => p.length <= 180)).toBe(true);
  expect(parts.join(' ')).toBe(text);
  expect(passengerBubbles('https://passenger.example/m/a.b?c=d')).toEqual(['https://passenger.example/m/a.b?c=d']);
  expect(passengerBubbles('unu\ndoi\ntrei\npatru')).toEqual(['unu', 'doi', 'trei', 'patru']);
});
it('sends every bubble in order and reports a partial delivery failure', async () => {
  const sent: string[] = [];
  const client = new WhatsAppClient({ WA_TOKEN: 't', WA_PHONE_NUMBER_ID: 'PN' }, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)).text.body);
    return new Response('{}', { status: sent.length === 2 ? 500 : 200 });
  }, 0);
  expect((await client.sendText('+40712345678', 'Coada: 12 min. '.repeat(30))).ok).toBe(false);
  expect(sent).toHaveLength(2);
});
