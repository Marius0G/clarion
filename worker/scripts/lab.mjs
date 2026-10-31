// Run deployed WhatsApp lab scripts. Credentials never appear in output.
import { readFile } from 'node:fs/promises';
let vars = '';
try { vars = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const match = /^\s*DEMO_TOKEN\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m.exec(vars);
const token = process.env.DEMO_TOKEN || match?.[1] || match?.[2] || match?.[3];
if (!token) throw Error('Set DEMO_TOKEN in worker/.dev.vars or the environment');
const base = process.env.CLARION_URL || 'https://clarion-backend.bogdan-c-2206.workers.dev';
let pass = true;
for (const script of process.argv.slice(2).length ? process.argv.slice(2) : [undefined]) {
  const res = await fetch(new URL('/lab/run', base), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ script }) });
  if (!res.ok) throw Error(`Lab HTTP ${res.status}: ${await res.text()}`);
  const report = await res.json();
  pass &&= report.pass;
  for (const [name, result] of Object.entries(report.results)) {
    console.log(`${result.violations.length ? 'FAIL' : 'PASS'} ${name}`);
    for (const turn of result.transcript) {
      console.log(`  > ${turn.user}\n    ${turn.replies.join('\n    ')}\n    [${turn.tools.join(', ') || 'no tools'}; ${turn.ms}ms]`);
    }
    for (const v of result.violations) console.log(`  turn ${v.turn}: ${v.rule}: ${v.detail}`);
  }
}
process.exitCode = pass ? 0 : 1;
