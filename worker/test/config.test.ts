import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('keeps the demo clock at the Unity speed', () => {
  expect(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')).toMatch(/^SIM_SPEED\s*=\s*"10"/m);
});
