import { defineConfig, type Options } from 'tsup';
import workerConfig from '../../apps/worker/tsup.config';

/**
 * The bundle that goes into the `worker` image.
 *
 * It extends `apps/worker/tsup.config.ts` rather than restating it: the
 * externals list there is a considered decision (`pg`/`ioredis` load native
 * bits, `bullmq` reads its Lua scripts off disk) and a second copy would drift
 * the first time one of them changes. Importing keeps the image's bundle in
 * step with the app's own build.
 *
 * Four entries, one image:
 *
 *  - `main.js`            — the worker process;
 *  - `db/src/migrate.js`  — `@shop/db`'s migrator;
 *  - `db/src/pending.js`  — the read-only question "is anything left to
 *    migrate?", which `shop upgrade` asks before it stops anything;
 *  - `db/src/seed/index.js` — the reference-data seed.
 *
 * The `db` entries keep their *source* directory shape on purpose. They
 * resolve data directories from `import.meta` at runtime — `../migrations` and
 * `../../seed-data` — so flattening them into `db/migrate.js` would send those
 * lookups outside the image. `web.Dockerfile`'s runtime stage copies
 * `migrations/` and `seed-data/` to the places this layout implies.
 *
 * This is what makes the `migrate` one-shot free: it is the worker image with a
 * different command, not a second ~300 MB image to pull into a maintenance
 * window on a 3.6 GB host.
 */

const base = workerConfig as Options;

export default defineConfig({
  ...base,
  // Resolved against the cwd tsup runs in, which is the workspace root.
  entry: {
    main: 'apps/worker/src/main.ts',
    'db/src/migrate': 'packages/db/src/migrate.ts',
    'db/src/pending': 'packages/db/src/pending.ts',
    'db/src/seed/index': 'packages/db/src/seed/index.ts',
  },
  outDir: 'docker/worker/dist',
});
