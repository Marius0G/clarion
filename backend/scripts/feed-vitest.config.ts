import { defineConfig } from 'vitest/config';
// Keep the package's suite plus owned feed tests; the shared config only discovers tests/.
export default defineConfig({ test: { include: ['tests/**/*.test.ts', 'scripts/feed-*.test.ts'] } });
