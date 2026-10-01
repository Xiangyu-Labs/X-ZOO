import { defineConfig } from 'tsup';

/**
 * One self-contained file: `node dist/shop.js`, or `shop` once linked. The
 * `@shop/*` packages ship TypeScript source, so they are bundled in; nothing
 * else is needed at runtime but Node 24.
 */
export default defineConfig({
  entry: { shop: 'src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  noExternal: [/./],
  // Tells `freshness.ts` it is the built file, whose hash means something.
  define: { __SHOP_CLI_BUNDLE__: 'true' },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
