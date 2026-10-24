import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works from any static host path (e.g. GitHub Pages project sites).
  base: './',
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
