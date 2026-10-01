import { defineConfig } from 'tsup';

/**
 * One bundled entry point, so the production image is `node dist/main.js` with
 * only the native/optional dependencies left external. Bundling keeps the
 * image small, which matters on a 2-core / 3.6 GB box.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // `pg` and `ioredis` load optional native bits at runtime; bundling them is
  // more trouble than the few hundred kilobytes are worth. `sharp` is a native
  // addon (libvips) that loads its platform's prebuilt `@img/sharp-*` package:
  // it cannot be inlined, and `pnpm deploy --prod` installs it with the
  // platform's binary (see `docker/worker.Dockerfile`).
  external: ['pg', 'pg-native', 'ioredis', 'bullmq', 'sharp'],
  // The `@shop/*` packages publish TypeScript source, not build output, so
  // tsup's default "externalise everything in dependencies" would leave the
  // bundle importing files that node cannot load. Bundle them.
  noExternal: [/^@shop\//],
  // `pnpm gen` must have run: `jobs.gen.ts` is an input, not an output.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
