import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { Tower } from '../src/index.js';

const row = { flight_iata: 'W63412', dep_iata: 'BGY', arr_iata: 'CRA',
  dep_time_ts: 1793462400, arr_time_ts: 1793469600 };
const envelope = (type: string, data = {}) => ({ type, ts: new Date().toISOString(), data });
let ready: Promise<void>;
let messages: any[];
let alarm: number | null;
let tower: Tower;
let fetcher: ReturnType<typeof vi.fn>;
async function start() {
  const ctx = {
    blockConcurrencyWhile(work: () => Promise<void>) { ready = work(); },
    storage: {
      sql: { exec: () => ({ toArray: () => [] }) },
      get: async () => undefined,
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => { alarm = at; },
      deleteAlarm: async () => { alarm = null; },
    },
    getWebSockets: () => [{ send: (m: string) => messages.push(JSON.parse(m)), deserializeAttachment: () => ({ client: 'twin' }) }],
  };
  tower = new Tower(ctx as any, { SIM_SPEED: '60' } as any);
  await ready;
}
async function state() {
  return (await tower.fetch(new Request('https://worker/api/state'))).json() as Promise<any>;
}
async function send(type: string, data = {}) {
  const ws = { deserializeAttachment: () => ({ client: type.startsWith('console.') ? 'console' : 'twin' }),
    send: (m: string) => messages.push(JSON.parse(m)) };
  await tower.webSocketMessage(ws as any, JSON.stringify(envelope(type, data)));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  alarm = null; messages = [];
  fetcher = vi.fn(async () => Response.json([row]));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Tower FIDS polling with mocked fetch', () => {
  it('fetches both directions at startup, refreshes every five minutes and broadcasts', async () => {
    await start();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://fids.flightradar.live/api/schedules/departures/CRA',
      'https://fids.flightradar.live/api/schedules/arrivals/CRA',
    ]);
    expect((await state()).dataSource).toBe('fids');
    expect((await state()).flights).toHaveLength(2);
    expect(alarm).toBe(Date.now() + 300000);
    await send('console.reset');
    expect((await state()).dataSource).toBe('fids');
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 300000);
    fetcher.mockImplementation(async () => Response.json([{ ...row, arr_delayed: 12 }]));
    await tower.alarm();
    expect(fetcher).toHaveBeenCalledTimes(4);
    const updated = await state();
    const arrival = updated.flights.find((f: any) => f.dir === 'arr');
    expect(Date.parse(arrival.est) - Date.parse(arrival.sched)).toBe(720000);
    expect(messages.at(-1)).toMatchObject({ type: 'state', data: { dataSource: 'fids' } });
    expect(alarm).toBe(Date.now() + 300000);
  });

  it.each(['http', 'malformed', 'empty', 'timeout'])('falls back on %s and recovers at the next alarm', async failure => {
    if (failure === 'http') fetcher.mockImplementation(async () => new Response('', { status: 503 }));
    if (failure === 'malformed') fetcher.mockImplementation(async () => Response.json({ error: true }));
    if (failure === 'empty') fetcher.mockImplementation(async () => Response.json([]));
    if (failure === 'timeout') fetcher.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason));
    }));
    const boot = start();
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(3000);
    await boot;
    expect((await state()).dataSource).toBe('fixture');
    expect((await state()).flights).toHaveLength(6);
    expect((await state()).dataSourceDetail).toContain('FIXTURE');
    fetcher.mockImplementation(async () => Response.json([row]));
    vi.setSystemTime(alarm!);
    await tower.alarm();
    expect((await state()).dataSource).toBe('fids');
    expect(alarm).toBe(Date.now() + 300000);
  });
});
