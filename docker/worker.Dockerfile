# syntax=docker/dockerfile:1.7
#
# The `worker` image: the BullMQ worker, and — under a different command — the
# `migrate` one-shot.
#
#   docker build -f docker/worker.Dockerfile -t x-zoo-worker .
#
#   worker:   node /app/main.mjs                (the default CMD)
#   migrate:  node /app/db/src/migrate.mjs && node /app/db/src/seed/index.mjs
#   pending:  node /app/db/src/pending.mjs      (read-only; `shop upgrade` asks it first)
#
# `.mjs`, not `.js`: the bundle is ESM and `/app` has no `package.json` of its
# own, so the extension is what tells node how to read it.
#
# ## `pnpm deploy --prod` or an esbuild bundle? Both, for different halves.
#
# `pnpm deploy --prod` alone does not produce a runnable image here. The
# `@shop/*` packages publish **TypeScript source** — `packages/db/package.json`
# exports `./src/index.ts` — so a pruned `node_modules` leaves node importing
# files it cannot parse. Making it work would mean either adding a TS loader to
# production (a devDependency in the runtime path, and a startup cost on every
# boot) or asking four packages to emit build output they otherwise do not need.
#
# An esbuild bundle alone does not work either. `bullmq` reads its Lua scripts
# from disk at runtime, `pg` and `ioredis` load optional native bindings: all
# three break when inlined, which is why `apps/worker/tsup.config.ts` lists them
# as external.
#
# So: **tsup (esbuild) bundles everything we wrote**, `@shop/*` included, and
# **`pnpm deploy --prod` materialises only the handful of packages the bundle
# deliberately left external**. The result is ~200 MB against ~1.4 GB for a
# whole-workspace image, which matters on a 2-core / 3.6 GB host that holds
# the running release and the next one side by side.

ARG NODE_IMAGE=node:24-slim

# --- build ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
RUN corepack enable
WORKDIR /build

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    corepack pnpm install --frozen-lockfile

# `jobs.gen.ts` is a bundle *input*, not an output: without this the worker
# starts with no jobs registered at all.
RUN corepack pnpm gen

# tsup compiles its config file in place, so the config's own `from 'tsup'`
# import is resolved from `docker/worker/`. Under pnpm's strict layout that
# directory sees nothing, and `tsup` only exists in `apps/worker/node_modules`.
# Borrowing that directory is a build-time symlink, which keeps the image's
# bundle config here, next to the Dockerfile, rather than inside `apps/worker`.
RUN ln -sfn /build/apps/worker/node_modules /build/docker/worker/node_modules \
    && ./apps/worker/node_modules/.bin/tsup --config docker/worker/tsup.config.ts \
    && rm -f /build/docker/worker/node_modules

# The externals, and nothing else. `--legacy` keeps `pnpm deploy` working
# against a workspace that does not inject its dependencies.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    corepack pnpm deploy --filter @shop/worker --prod --legacy /deploy \
    && rm -rf /deploy/node_modules/@shop

# --- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=node:node /deploy/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /build/docker/worker/dist/ ./
# `migrate.js` resolves `../migrations` and `seed/index.js` resolves
# `../../seed-data` from `import.meta`; see docker/worker/tsup.config.ts.
COPY --from=build --chown=node:node /build/packages/db/migrations/ ./db/migrations/
COPY --from=build --chown=node:node /build/packages/db/seed-data/ ./db/seed-data/
COPY --chown=node:node docker/healthcheck/worker.mjs /app/healthcheck.mjs

# Same reason as the web image: a named volume inherits this ownership.
RUN mkdir -p /data/uploads && chown -R node:node /data

USER node
VOLUME ["/data/uploads"]

# SIGTERM has to reach node for `stop()` to drop the heartbeat and drain the
# in-flight jobs; PID 1 without an init swallows it.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/main.mjs"]
