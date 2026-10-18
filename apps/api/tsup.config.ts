import { defineConfig } from 'tsup';

/**
 * The API bundles the workspace packages (they ship TypeScript sources, see
 * `packages/*/package.json`), so the built artifact is a single self-contained
 * ESM file. `tsx` runs the same entrypoint in development without bundling.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/worker.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  // Everything under the workspace scope is source, not a published dependency.
  noExternal: [/^@trade-copier\//],
  external: ['pg-native'],
});
