import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': new URL('./test/durable-object.ts', import.meta.url).pathname } },
  test: { include: ['test/**/*.test.ts'], fileParallelism: false, testTimeout: 20000, hookTimeout: 30000 },
});
