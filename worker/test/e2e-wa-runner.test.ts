import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

it('runs the one-command WhatsApp checks against workerd and restores flight, gate and subscriber state', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const graph: any[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'e2e-wa-runner', host: '127.0.0.1', port: 0, modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-30',
    durableObjects: { TOWER: { className: 'Tower', useSQLite: true } },
    bindings: { DEMO_TOKEN: 'runner-operator', WHATSAPP_APP_SECRET: 'runner-secret', WHATSAPP_TOKEN: 'graph-token', WHATSAPP_PHONE_NUMBER_ID: 'PN1',
      GOOGLE_WALLET_ISSUER_ID: '123456', GOOGLE_WALLET_SA_EMAIL: 'test@example.invalid',
      GOOGLE_WALLET_SA_KEY: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----` },
    outboundService: async request => {
      if (request.url.startsWith('https://graph.facebook.com/')) {
        graph.push(await request.json());
        return Response.json({ error: { code: 131030 } }, { status: 400 });
      }
      return Response.json([]);
    },
  }));
  const web = createServer((req, res) => {
    if (req.url === '/assets/app.js') { res.setHeader('content-type', 'application/javascript'); res.end('// fixture app bundle\n' + ' '.repeat(120)); }
    else { res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/assets/app.js"></script>'); }
  });
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
  try {
    const base = await mf.ready;
    const api = async (path: string): Promise<any> => (await mf.dispatchFetch(new URL(path, base).href, { headers: { authorization: 'Bearer runner-operator' } })).json();
    const before = await api('/api/sim');
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/e2e-wa.mjs'], { env: { ...process.env,
      DEMO_TOKEN: 'runner-operator', WHATSAPP_APP_SECRET: 'runner-secret', CLARION_URL: base.href,
      CLARION_WEB_URL: `http://127.0.0.1:${(web.address() as { port: number }).port}` }, timeout: 60000 });
    for (const step of [1, 2, 3, 4, 5, 6, 7]) expect(stdout).toContain(`PASS ${step} `);
    expect(stdout).toContain('0 failed, 0 skipped');
    const after = await api('/api/sim');
    expect(after.flights).toEqual(before.flights);
    expect(after.lanes).toEqual(before.lanes);
    expect(after.blocked).toEqual(before.blocked);
    expect((await api('/lab/capabilities')).safeToMutate).toBe(true);
    expect(graph.length).toBeGreaterThan(0);
    expect(graph.filter(b => b.to).every(b => /^999000000\d{6}$/.test(b.to))).toBe(true);
  } finally {
    await mf.dispose();
    await new Promise<void>((resolve, reject) => web.close(error => error ? reject(error) : resolve()));
  }
}, 70000);
