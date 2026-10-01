# `load` — the load smoke

One command, from the repository root:

```
pnpm --filter @shop/e2e-admin exec tsx ../../load/run.ts
```

It starts PostgreSQL 17 and Redis 7 (`docker run`, compose's memory limits,
swap off, `pg_stat_statements` on). It builds the schema with `@shop/testing`,
seeds a storefront and starts the fake WeChat Pay gateway. It runs the web
standalone server and the worker in `systemd-run --user --scope` cgroups
(512M / 320M, swap off). Then it signs 16 shoppers in, smoke-tests every flow,
waits while the 1-minute load average is above 12, warms up for 15 s and
measures for 60 s. It tears everything down at the end, including on failure
or Ctrl-C. Results go to `$TMPDIR/shop-load/<timestamp>/` (`result.json`,
`tables.md`, `web.log`, `worker.log`), never into the repository.

Prerequisites: Docker, `systemd-run --user` with the memory controller
delegated (true on WSL2 with systemd), and both builds present. Build them with
`pnpm turbo run build --filter @shop/web --filter @shop/worker`. The script
refuses to start without them and never rebuilds, so it cannot clobber a
`apps/web/.next` another process is using.

| Variable                 | Default | What                                          |
| ------------------------ | ------: | --------------------------------------------- |
| `SHOP_LOAD_VUS`          |      16 | virtual users (one shopper each)              |
| `SHOP_LOAD_SECONDS`      |      60 | measured window                               |
| `SHOP_LOAD_WARMUP`       |      15 | warm-up before it                             |
| `SHOP_LOAD_MAX_LOADAVG`  |      12 | wait while the 1-min load average is above it |
| `SHOP_LOAD_MAX_WAIT_MIN` |      30 | …for at most this long, then run anyway       |
| `SHOP_LOAD_PORT`         |    3471 | web port (127.0.0.1)                          |
| `SHOP_LOAD_PG_PORT`      |   55471 | PostgreSQL port (127.0.0.1)                   |
| `SHOP_LOAD_REDIS_PORT`   |   56471 | Redis port (127.0.0.1)                        |
| `SHOP_LOAD_LOG_LEVEL`    |    warn | web and worker log level                      |

This directory is **not a workspace package**. `lib/deps.ts` resolves
`@shop/*`, `pg` and `drizzle-orm` as if imported from `@shop/e2e-admin`, and
the script runs through that package's `tsx`. For the same reason,
`turbo run typecheck lint` does not cover it.

## What it measures

The storefront is seeded through the core services: 3 parent and 6 leaf
categories, 20 products with one SKU each (stock 1e6, free freight), a
a decorated 首页 (a search bar and two product grids), WeChat Pay pointing at the
in-process fake gateway (real RSA and AEAD), and 16 shoppers who sign in over
HTTP and add an address. A one-pass smoke of every flow must succeed first.
Then the virtual users run a closed loop with no think time, picking flows by
weight:

| flow             | weight | requests                                                                                                                                             |
| ---------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| home             |     20 | `GET /api/v1/pages/home`                                                                                                                             |
| category         |     20 | `GET /api/v1/catalog/categories`, then `GET /api/v1/catalog/products?categoryId`                                                                     |
| product detail   |     25 | `GET /api/v1/catalog/products/:id`, signed in                                                                                                        |
| cart add         |     15 | `POST /api/v1/cart/items`                                                                                                                            |
| checkout preview |     10 | `POST /api/v1/checkout/preview`, buy-now                                                                                                             |
| order + pay      |     10 | `POST /api/v1/orders` → `POST /api/v1/orders/:id/payments` → gateway `markPaid` → signed `TRANSACTION.SUCCESS` to `POST /api/v1/webhooks/wechat-pay` |

A request counts if it started inside the window. An error is any non-2xx or
transport failure (30 s timeout). Percentiles are exact nearest-rank. Memory
is read from each service's cgroup files (`memory.current`, `memory.stat`,
`memory.peak`) every 2 s; the working set is `memory.current` minus
`inactive_file`, as `docker stats` shows it.

Not covered: coupons, group-buy and presale (not seeded); the cart page;
SMS and WeChat sign-in (password sign-in stands in).

`/api/v1/readyz` answers 503 during a run, harmlessly: `@shop/testing` builds
the schema by replaying the committed migration SQL without writing drizzle's
journal table, so the `migrations` check reports failed although the schema is
identical. `run.ts` waits on the other three checks (database, Redis, worker
heartbeat).

## Reference run

A 32-core workstation with memory limited exactly as compose limits it, CPU
uncapped. The memory numbers transfer to the 2-core / 3.6 GB production host;
latency and throughput are optimistic for it.

- 16 shoppers, 60 s after 15 s warm-up: about 15 900 requests, **0 errors**,
  overall p50 63 / p95 137 / p99 184 ms. Every order ended paid.
- The four services used about **556 MiB steady, 566 MiB peak** of the
  1504 MiB their limits allow (1568 MiB with the edge). Web is the one to
  watch: V8 grows the heap toward its 384 MiB old-space cap before collecting
  hard, so flat-and-high (about 370 of 512 MiB) is expected.
- No N+1: category lists, cart add and product detail each issue a fixed
  number of statements per request, and auth issues exactly three.
- The costliest statements by total time were the home page read (the legacy
  DIY page then; this run predates the cutover), the
  `products.views` bump and the stock decrement. The stock decrement is the
  oversell guard and its cost is lock waiting on shared SKUs, by design.

A run that moves far from these numbers on comparable hardware is worth a look
at `tables.md` before it is worth anything else.
