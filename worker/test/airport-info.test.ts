import { describe, expect, it } from 'vitest';
import { airportInfo } from '../src/wa/airport-info.js';
import guide from '../src/wa/airport-guide.json';
import { fallbackReply, reply, TOOL_SPECS } from '../src/wa/agent.js';
import { toolsFor } from '../src/wa/tools.js';

const view = { clock: () => ({ now: 8 * 3600, sim: true }), flow: () => ({}), flights: () => [], provisional: () => true };
const tools = (lang: 'ro' | 'en') => toolsFor({ view, profile: () => ({ phone: '+40712345678', role: 'passenger', lang }), save: async () => {} });

describe('airport guide matching', () => {
  it('matches a topic, query and their intersection, preserving provenance and snapshot date', () => {
    const parking = airportInfo({ topic: 'parking' }, 'en');
    expect(parking).toMatchObject({ found: true, asOf: '2026-10-31' });
    expect(parking.facts.every(f => f.topic === 'parking' && f.source.startsWith('https://'))).toBe(true);
    expect(airportInfo({ query: 'liquids' }).facts.every(f => f.fact.includes('Lichid') || f.fact.includes('lichid'))).toBe(true);
    expect(airportInfo({ topic: 'security', query: 'laptops' }, 'en').facts).toMatchObject([{ topic: 'security', official: true, text: expect.stringContaining('laptops') }]);
    expect(airportInfo({ topic: 'parking', query: 'laptops' }).found).toBe(false);
    expect(airportInfo({ query: 'Cât costă parcarea?' }).facts.some(f => f.fact.includes('lei'))).toBe(true);
  });
  it('labels every unofficial fact as unconfirmed in either passenger language', () => {
    for (const lang of ['ro', 'en'] as const) {
      const f = airportInfo({ topic: 'services' }, lang).facts[0]!;
      expect(f.official).toBe(false);
      expect(f.status).toBe('unconfirmed');
      expect(f.label).toBe(lang === 'en' ? 'Unconfirmed' : 'Neconfirmat');
      expect(f.source).toContain('stiricraiova.ro');
    }
  });
  it.each(['Wi-Fi password', 'taxi prices', 'business lounge', 'parking wifi', 'CT scanners'])('does not substitute unrelated facts for missing information: %s', query => {
    expect(airportInfo({ query })).toMatchObject({ found: false, error: 'not_found', facts: [] });
  });
  it('rejects unknown and prototype topics, and empty queries', () => {
    for (const topic of ['unknown', '__proto__', 'constructor']) expect(airportInfo({ topic }).found).toBe(false);
    expect(airportInfo().found).toBe(false);
  });
  it('has a curated English translation for each fact and descriptive Romanian alternatives for imperatives', () => {
    for (const facts of Object.values(guide.topics)) for (const fact of facts) expect(fact.en.length).toBeGreaterThan(10);
    for (const topic of ['security', 'wizz_checkin', 'special_assistance', 'parking']) {
      const results = airportInfo({ topic });
      expect(results.facts.map(f => f.text).join(' ')).not.toMatch(/trebuie să fii|nu înfoliați|nu împachetați|să meargă|să ieși/i);
    }
  });
});

describe('airport questions in the agent', () => {
  it('exposes both tools to the model', () => {
    expect(TOOL_SPECS.map(t => t.name)).toEqual(expect.arrayContaining(['airportInfo', 'rememberFact']));
  });
  it.each(['ro', 'en'] as const)('uses sourced static facts and admits missing facts in %s without a model', async lang => {
    const used: string[] = [];
    const answer = await fallbackReply(lang === 'en' ? 'How much is parking?' : 'Cât costă parcarea?', tools(lang), used, 'passenger', lang);
    expect(used).toEqual(['airportInfo']);
    expect(answer.join(' ')).toContain('https://aeroportcraiova.ro/tarife-parcare/');
    expect(answer.join(' ')).toContain(lang === 'en' ? 'Parking' : 'Parcar');
    const missing = await fallbackReply('Wi-Fi password?', tools(lang), [], 'passenger', lang);
    expect(missing[0]).toContain(lang === 'en' ? "I don't know" : 'Nu știu');
    const cafes = await fallbackReply(lang === 'en' ? 'coffee' : 'cafea', tools(lang), [], 'passenger', lang);
    expect(cafes.join(' ')).toContain(lang === 'en' ? 'Where are you now?' : 'Unde ești acum?');
  });
  it('keeps live queue questions on the queue tool', async () => {
    const used: string[] = [];
    await fallbackReply('is the security queue busy?', tools('en'), used, 'passenger', 'en');
    expect(used).toEqual(['queues']);
  });
  it('instructs the model to use sources, admit missing facts and retain passenger tone and language', async () => {
    let system = '';
    await reply({ env: { ANTHROPIC_API_KEY: 'k' }, fetcher: async (_url, init) => {
      system = JSON.parse(String(init?.body)).system.map((s: any) => s.text).join('\n');
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: "I don't know." }] });
    }, profile: { phone: '+40712345678', role: 'passenger', lang: 'en' }, clock: view.clock(), history: [], text: 'WiFi?', tools: tools('en') });
    for (const rule of ['airportInfo', 'found=false', 'official=false', 'fără ordine', 'English', 'Urgent exception']) expect(system).toContain(rule);
  });
});
