import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';

// camera.frame end to end in workerd: vision socket → memory → console sockets, GET /cams and GET /cams/<id>.jpg.
let mf: Miniflare;
const sockets: { close(): void }[] = [];
beforeAll(() => {
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'cams', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    bindings: { DEMO_TOKEN: 'op', SIM_SPEED: '10' },
    outboundService: async () => Response.json([]),
  }));
});
afterAll(async () => { for (const ws of sockets) ws.close(); await mf.dispose(); });
const envelope = (type: string, data: unknown) => JSON.stringify({ type, ts: new Date().toISOString(), data });
async function connect(client: string) {
  const response = await mf.dispatchFetch(`https://worker.example/ws?client=${client}&token=op`, { headers: { Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const messages: any[] = [];
  ws.addEventListener('message', e => messages.push(JSON.parse(String(e.data))));
  ws.accept(); sockets.push(ws);
  await expect.poll(() => messages.some(m => m.type === 'state')).toBe(true);
  return { send: (type: string, data: unknown) => ws.send(envelope(type, data)), of: (type: string) => messages.filter(m => m.type === type).map(m => m.data) };
}
const bytes = [0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 0xff, 0xd9];
const jpeg = Buffer.from(bytes).toString('base64');
const frame = (extra = {}) => ({ camera: 'cctv_security_queue', zone: 'U_SECURITY_QUEUE', simTime: 54335, w: 960, h: 540, jpeg, count: 37, detector: 'yolo', ...extra });
const get = (path: string, token?: string) => mf.dispatchFetch(`https://worker.example${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

it('keeps the latest frame per camera, forwards it to consoles and serves it behind the operator token', async () => {
  const consoleWs = await connect('console');
  const vision = await connect('vision');
  vision.send('camera.frame', frame());
  await expect.poll(() => consoleWs.of('camera.frame').length).toBe(1);
  expect(consoleWs.of('camera.frame')[0]).toEqual(frame());

  expect((await get('/cams')).status).toBe(401);
  expect((await get('/cams', 'wrong')).status).toBe(401);
  const list = await (await get('/cams', 'op')).json() as any[];
  expect(list).toMatchObject([{ camera: 'cctv_security_queue', zone: 'U_SECURITY_QUEUE', simTime: 54335, count: 37, detector: 'yolo', w: 960, h: 540 }]);
  expect(list[0].age).toBeGreaterThanOrEqual(0);

  const image = await get('/cams/cctv_security_queue.jpg', 'op');
  expect(image.status).toBe(200);
  expect(image.headers.get('content-type')).toBe('image/jpeg');
  expect(image.headers.get('cache-control')).toBe('no-store');
  expect([...new Uint8Array(await image.arrayBuffer())]).toEqual(bytes);
  // ?token= works too, for a plain <img src>.
  expect((await get('/cams/cctv_security_queue.jpg?token=op')).status).toBe(200);
  expect((await get('/cams/cctv_nowhere.jpg', 'op')).status).toBe(404);

  // Every frame vision sends replaces the last one (vision paces the cameras); a camera over no queue has zone null.
  vision.send('camera.frame', frame({ simTime: 54336 }));
  vision.send('camera.frame', frame({ camera: 'cctv_hall_east', zone: null, count: 3, detector: 'simulated' }));
  await expect.poll(async () => (await (await get('/cams', 'op')).json() as any[]).length).toBe(2);
  const cams = await (await get('/cams', 'op')).json() as any[];
  expect(cams.map(c => [c.camera, c.zone, c.simTime])).toEqual([['cctv_hall_east', null, 54335], ['cctv_security_queue', 'U_SECURITY_QUEUE', 54336]]);
  expect(vision.of('error')).toEqual([]);
  // Frames never enter the engine or the state broadcast.
  expect(((await (await get('/api/sim')).json()) as any).cams).toBeUndefined();
});

it('accepts frames only from vision and reports invalid ones', async () => {
  const twin = await connect('twin');
  twin.send('camera.frame', frame({ camera: 'cctv_upper_4' }));
  await expect.poll(() => twin.of('error').length).toBe(1);
  expect(twin.of('error')[0].message).toBe('Client cannot issue this event');
  const vision = await connect('vision');
  vision.send('camera.frame', frame({ camera: 'cctv_upper_4', jpeg: Buffer.from('GIF89a').toString('base64') }));
  await expect.poll(() => vision.of('error').length).toBe(1);
  expect(vision.of('error')[0].message).toMatch(/not a JPEG/);
  const list = await (await get('/cams', 'op')).json() as any[];
  expect(list.some(c => c.camera === 'cctv_upper_4')).toBe(false);
});
