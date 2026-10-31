// Local end-to-end proof: real Node HTTP routes + Vite + Chromium + curl-signed Meta payload.
import { chromium } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = await mkdtemp(join(tmpdir(), 'clarion-login-'));
const backendPort = process.env.AUTH_BACKEND_PORT || '18787';
const appPort = process.env.AUTH_APP_PORT || '15173';
const base = `http://127.0.0.1:${backendPort}`;
const secret = 'local-auth-smoke-secret';
const children = [];
let browser;
function start(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', data => { child.output += data; });
  child.stderr.on('data', data => process.stderr.write(data));
  children.push(child);
  return child;
}
async function ready(url, child, marker) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Dev server exited: ${child.exitCode}`);
    try { if (child.output.includes(marker) && (await fetch(url)).ok) return; } catch { /* Starting. */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server not ready: ${url}`);
}
try {
  const backend = start(['--import', 'tsx', '--input-type=module', '-e',
    `import {createControlTower} from './src/server.ts'; const s=createControlTower(); s.http.listen(${Number(backendPort)}, '127.0.0.1',()=>console.log('AUTH_READY')); process.on('SIGTERM',()=>s.stop().then(()=>process.exit()));`], join(root, 'backend'), {
    STATE_FILE: join(temp, 'state.json'), WHATSAPP_APP_SECRET: secret, WHATSAPP_TOKEN: '', WA_TOKEN: '', ANTHROPIC_API_KEY: '', WA_ALLOWLIST: '', STAFF_PHONES: '', DEMO_OTP: '',
  });
  const app = start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', appPort, '--strictPort'], join(root, 'app'), {
    VITE_BACKEND_HTTP: base, VITE_BACKEND_URL: base.replace('http:', 'ws:') + '/ws?client=console',
  });
  await Promise.all([ready(`${base}/health`, backend, 'AUTH_READY'), ready(`http://localhost:${appPort}/join`, app, `http://127.0.0.1:${appPort}`)]);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('https://wa.me/**', route => route.fulfill({ contentType: 'text/html', body: '<p>WhatsApp simulation</p>' }));
  const page = await context.newPage();
  await page.goto(`http://localhost:${appPort}/join`);
  const codeResponse = page.waitForResponse(r => r.url() === `${base}/api/auth/login-code`);
  await page.getByRole('button', { name: 'Conectează-te cu WhatsApp' }).click();
  const pending = await (await codeResponse).json();
  await page.getByText('Așteptăm mesajul…').waitFor();
  const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'smoke-login', from: '40712345678',
    timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: `LOGIN ${pending.code}` } }] } }] }] });
  const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const { stdout } = await promisify(execFile)('curl', ['--fail', '--silent', '--show-error', '-X', 'POST', `${base}/webhooks/whatsapp`,
    '-H', 'Content-Type: application/json', '-H', `X-Hub-Signature-256: ${signature}`, '--data-binary', raw]);
  assert.deepEqual(JSON.parse(stdout), { ok: true });
  await page.getByRole('button', { name: 'Deconectare' }).waitFor({ timeout: 15000 });
  const session = await page.evaluate(() => localStorage.getItem('clarion.session'));
  assert.match(session, /^[a-f0-9]{64}$/);
  const me = await (await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${session}` } })).json();
  assert.equal(me.phone, '+40712345678');
  await fetch(`${base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` }, body: JSON.stringify({ flight: 'W6 3751' }) });
  await page.reload();
  await page.getByText('W6 3751', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Deconectare' }).click();
  await page.getByRole('button', { name: 'Conectează-te cu WhatsApp' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('clarion.session')), null);
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${session}` } })).status, 401);
  console.log('PASS: reverse login → signed webhook via curl → browser session → restored flight → logout');
} finally {
  await browser?.close();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  })));
  await rm(temp, { recursive: true, force: true });
}
