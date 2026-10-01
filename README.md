# X-ZOO Shop

[简体中文](./README_ZH.md) | English

A single-merchant online shop for the Chinese market. Shoppers buy through a WeChat mini-program;
the merchant runs the shop from a web admin console.

What it does:

- **Catalog**: products with specifications and SKUs, categories, labels, parameters, reviews,
  keyword search.
- **Buying**: cart, checkout with shipping templates and coupon allocation, orders, invoices on
  request, automatic cancellation and receipt.
- **Payment and after-sales**: WeChat Pay v3 (JSAPI, mini-program and H5), reconciliation of stale
  payments, refunds with approval.
- **Marketing**: coupons, group buying (拼团) and presale (预售).
- **Fulfilment**: shipping, split shipments, logistics tracking.
- **Content**: a block-based page designer (店铺装修) for the mini-program, articles, agreements.
- **Customers**: SMS, password, mini-program and WeChat official-account sign-in; addresses, labels
  and groups.
- **WeChat official account**: menus, auto-replies, QR codes, media.
- **Operations**: roles built from permission atoms, an audit log, notifications (in-app, message
  templates, subscription messages), a statistics dashboard, local or S3-compatible storage.

## Stack

| Part          | What it is                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`    | Next.js 16 (App Router, standalone). The admin at `/admin` (React 19, Ant Design 6), its API at `/admin-api/*`, the storefront API at `/api/v1/*`. |
| `apps/worker` | The BullMQ worker: scheduled jobs, on-demand jobs, and the dispatcher of post-commit side effects.                                                 |
| PostgreSQL 17 | The only database. Schema and migrations in Drizzle.                                                                                               |
| Redis 7       | Admin sessions, the config cache, rate limits, the job queue, pub/sub for live admin notifications.                                                |
| `apps/mini`   | The WeChat mini-program storefront (Taro 4, React 18). Its "模拟小程序" H5 build is for e2e and the designer's preview only.                       |
| edge          | nginx in front of everything: proxies `/` (the landing page), `/admin`, `/admin-api`, `/api` and `/scan-upload` to `web`, serves `/uploads/`.      |

Everything is strict TypeScript on Node 24 and pnpm. Every endpoint is declared
once, as a zod contract in `packages/contracts`; the OpenAPI document, the typed admin client, the
mock server and the guards all derive from it. See [docs/architecture.md](docs/architecture.md).

## Repository layout

```
apps/
  web/          Next.js: admin pages, /admin-api, /api/v1
  worker/       the BullMQ worker and its jobs
  mini/         the WeChat mini-program (Taro)
packages/
  config/       shared ESLint, TypeScript and Vitest presets
  contracts/    route contracts (zod) → OpenAPI; the single source of truth for the API
  core/         the domain logic, one directory per domain, plus kernel/
  db/           Drizzle schema, migrations, the reference-data seed
  testing/      Testcontainers harness, factories, fake WeChat and SMS gateways, the mock server
  api-client/   the typed /api/v1 client the mini-program uses
  storefront-blocks/  the decoration blocks shared by the mini-program and the admin designer
e2e/            Playwright suites: admin/ and storefront/
guards/         whole-tree static checks (pnpm guards)
load/           the load smoke
docker/         the web, worker and edge images
deploy/         the production Compose stack, the host command `shop`, and ship.sh
docs/           architecture, conventions, contributing, the business-rule catalogue
```

## Local development

### Prerequisites

- Node 24 and pnpm 12 (`corepack enable` gives you the pinned version).
- Docker, for PostgreSQL and Redis, the integration tests and the e2e suites.

### Start

```sh
pnpm install
pnpm gen          # the generated aggregates (*.gen.ts, openapi.json) are not committed

docker run -d --name shop-pg -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=shop -e POSTGRES_PASSWORD=shop -e POSTGRES_DB=shop postgres:17
docker run -d --name shop-redis -p 127.0.0.1:6379:6379 redis:7 \
  redis-server --maxmemory-policy noeviction

export DATABASE_URL=postgres://shop:shop@127.0.0.1:5432/shop
export REDIS_URL=redis://127.0.0.1:6379
export UPLOADS_DIR="$PWD/.uploads"
export VALIDATE_RESPONSES=1       # check every response against its contract

pnpm --filter @shop/db db:migrate   # the schema
pnpm --filter @shop/db db:seed      # reference data: cities, express companies, templates
pnpm dev                            # web on http://localhost:3000, and the worker
```

The seed loads reference data only. It creates no admin account, and nothing in the product can
grant `is_super`, so create the first one in the database. The hash is bcrypt; the password is read
from the terminal, not from the command line:

```sh
(cd packages/core && read -rs PW && PW="$PW" node --input-type=module \
  -e "import b from 'bcryptjs'; console.log(await b.hash(process.env.PW, 10))")
docker exec -i shop-pg psql -U shop shop <<'SQL'
insert into admins (account, password_hash, name, is_super)
values ('admin', '<the hash>', '超级管理员', true);
SQL
```

Then sign in at <http://localhost:3000/admin>. `/admin/dev/kit` shows every admin kit component
live.

For a stack already seeded with an admin, a product, a coupon and a shopper, start the admin e2e
server instead: `pnpm --filter @shop/e2e-admin exec tsx scripts/serve.ts`. It runs its own
PostgreSQL and Redis in Testcontainers, and signs in as `e2e-super` / `e2e-Passw0rd!`.

### The mini-program

`apps/mini` is a workspace package like the others:

```sh
pnpm --filter @shop/mini dev:weapp     # dist/weapp, to import into 微信开发者工具
pnpm --filter @shop/mini build         # the WeChat package, the H5 preview and the size gate
```

The API origin comes from `TARO_APP_API_ORIGIN`; a developer's own AppID and origin go in
`apps/mini/.env.*.local`. [docs/mini/](docs/mini/README.md) is its design, and
[docs/mini/device-check.md](docs/mini/device-check.md) how to try it in the developer tools and
on a phone.

## Checks

A change merges when all of these pass. [docs/contributing.md](docs/contributing.md) has the full
checklist and what each step proves.

```sh
pnpm turbo run gen typecheck lint test:unit build
pnpm turbo run test:int --force --concurrency=4     # needs Docker
pnpm --filter @shop/contracts check:examples
pnpm exec prettier --check .
pnpm guards                                          # 0 failures
pnpm --filter @shop/e2e-admin e2e                    # serves the build of apps/web
pnpm --filter @shop/e2e-storefront test            # the mini-program's "模拟小程序" H5 build
```

CI (`.github/workflows/ci.yml`) runs all of these, plus shellcheck, the deploy drill and, on a push, the build of the three production images.

## Deployment

The shop runs as one Docker Compose project on one host: PostgreSQL, Redis, `web`, `worker` and the
nginx `edge`, behind Traefik. Images are built in CI and deployed by digest. A release is one
command from a machine with the repository, `deploy/ship.sh <commit>`. First deploy, release,
rollback, backup and restore are in [deploy/README.md](deploy/README.md).

## Documentation

- [docs/architecture.md](docs/architecture.md): how the system is put together.
- [docs/conventions.md](docs/conventions.md): the engineering rules the code follows.
- [docs/contributing.md](docs/contributing.md): the merge checklist; how to add a domain, a route
  or a contract.
- [docs/invariants.md](docs/invariants.md): the business rules, each with the tests that prove it.
- [deploy/README.md](deploy/README.md): operating the production stack.

## Licence

Proprietary. Copyright (c) 2026 XIANGYU MOU. All rights reserved. See [LICENSE](LICENSE).
