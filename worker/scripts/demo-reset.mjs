const url = process.env.CLARION_URL || 'https://clarion-backend.bogdan-c-2206.workers.dev';
const token = process.env.DEMO_TOKEN;
if (!token) { console.error('DEMO_TOKEN is required'); process.exit(1); }
try {
  const response = await fetch(`${url.replace(/\/$/, '')}/api/demo/reset`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000),
  });
  console.log(await response.text());
  if (!response.ok) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
