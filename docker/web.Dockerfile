# syntax=docker/dockerfile:1.7
#
# The `web` image: the Next.js standalone server that serves `/admin`,
# `/admin-api/*` and `/api/v1/*`.
#
#   docker build -f docker/web.Dockerfile -t x-zoo-web ./next
#
# The build context is the repository root (the pnpm workspace root), filtered by the
# adjacent `web.Dockerfile.dockerignore`. A per-Dockerfile ignore file is used
# rather than a root `.dockerignore` so each image states its own context filter
# next to its Dockerfile.
#
# Why the whole workspace is copied before `pnpm install`, rather than the usual
# manifests-only layer: a hardcoded list of `COPY packages/<name>/package.json`
# lines has to be edited every time a package is added, and a forgotten line
# fails only inside the image build. The pnpm store cache mount
# gives back most of what the finer-grained layer would have saved.

ARG NODE_IMAGE=node:24-slim

# --- build ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
RUN corepack enable
WORKDIR /build

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    corepack pnpm install --frozen-lockfile

# `*.gen.ts` and `openapi.json` are gitignored (CONVENTIONS.md "Aggregation
# files"), so the build inputs do not exist until this runs.
RUN corepack pnpm gen

# `next.config.ts` sets `typescript.ignoreBuildErrors`: the merge gate already
# ran `pnpm typecheck`, and paying for it again here would double the slowest
# step in the release.
RUN corepack pnpm --filter @shop/web build

# The `shop` CLI, served by `apps/web/app/downloads/[file]/route.ts`: built
# from this commit, so its bundled operation list matches the routes here.
RUN corepack pnpm --filter @shop/cli build

# Next only emits `public/` into the standalone tree when the package has one.
# `apps/web` has none today; create it so the runtime COPY is not conditional.
RUN mkdir -p apps/web/public apps/web/.next/standalone/apps/web/public

# --- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=Asia/Shanghai

# `tini` reaps the children a Next server spawns and forwards SIGTERM, so a
# redeploy drains instead of being killed at the 10s docker timeout.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The standalone tree already carries the traced `node_modules`; `outputFileTracingRoot`
# is the workspace root, so `server.js` lands under `apps/web/`.
COPY --from=build --chown=node:node /build/apps/web/.next/standalone/ ./
COPY --from=build --chown=node:node /build/apps/web/.next/static/ ./apps/web/.next/static/
COPY --from=build --chown=node:node /build/apps/web/public/ ./apps/web/public/
COPY --from=build --chown=node:node /build/apps/cli/dist/shop.js ./apps/web/cli/shop.js
COPY --chown=node:node docker/healthcheck/web.mjs /app/healthcheck.mjs

# The uploads root is a volume in `deploy/compose.yml`. Creating it here,
# owned by the runtime user, is what makes a *named* volume inherit that
# ownership on first mount, with no manual `chown` on the host.
RUN mkdir -p /data/uploads && chown -R node:node /data

# uid 1000, shipped by the base image. Never root: an upload path bug in a
# container running as root is a host compromise.
USER node

EXPOSE 3000
VOLUME ["/data/uploads"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
