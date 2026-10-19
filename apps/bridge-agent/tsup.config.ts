import { defineConfig } from 'tsup';

/**
 * The agent ships as one runnable file so it can be dropped next to a terminal
 * on a Windows VPS (`node dist/index.js`) without a package manager.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  noExternal: [/^@trade-copier\//],
});
