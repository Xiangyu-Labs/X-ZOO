import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The handoff between `scripts/serve.ts` (which owns the containers, the web
 * server, the worker, the fake gateway and the edge) and the specs (which need
 * the same database and Redis to arrange what the storefront cannot create by
 * itself, and to read back what it cannot show).
 *
 * A file rather than an environment variable, for the reason `@shop/e2e-admin`
 * gives: Playwright spawns the `webServer` command as a child, so the parent
 * cannot read anything the child discovers, and the container ports are only
 * known once the containers are up.
 *
 * It lives in the system temp directory, never in the repository, so no run
 * leaves behind something `git status` would show or `prettier` would
 * reformat.
 *
 * ## One checkout, one stack
 *
 * The same rule as `@shop/e2e-admin`: several checkouts (worktrees) may run
 * this suite on one machine at once. With fixed ports, one fixed stack file
 * and `reuseExistingServer` on, the second run's Playwright would find the
 * first run's edge answering, reuse it, and drive its specs against the
 * *other* checkout's H5 bundle, build and database. So:
 *
 * - the default ports and stack file are derived from the checkout's path
 *   (`CHECKOUT_ID` below), so two checkouts never share them by default;
 * - reusing a server that is already up is opt-in, `SHOP_E2E_REUSE=1`
 *   (`playwright.config.ts`); without it a busy port is an error, not a
 *   silent handover;
 * - `SHOP_E2E_PORT`, `SHOP_E2E_WEB_PORT`, `SHOP_E2E_GATEWAY_PORT` and
 *   `SHOP_E2E_STOREFRONT_STACK` still override each, e.g. to run the same
 *   checkout twice.
 */

/** The checkout root, resolved from this file. */
export const CHECKOUT_ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * Eight hex digits of the checkout path's SHA-256: stable per checkout,
 * distinct across them.
 */
export const CHECKOUT_ID = createHash('sha256').update(CHECKOUT_ROOT).digest('hex').slice(0, 8);

/**
 * The first of this checkout's three default ports (edge, web, gateway):
 * 25000–30999, in steps of three. Clear of the admin suite's 20000–24999 and
 * below Linux's ephemeral range (32768+). A clash between a handful of
 * worktrees is unlikely and loud (a port is busy), never a silent reuse.
 */
const DEFAULT_BASE_PORT = 25_000 + (Number.parseInt(CHECKOUT_ID, 16) % 2_000) * 3;

export const STACK_FILE =
  process.env.SHOP_E2E_STOREFRONT_STACK ??
  path.join(tmpdir(), `shop-e2e-storefront-${CHECKOUT_ID}.json`);

/**
 * The port the *browser* talks to: the edge, which serves the H5 bundle and
 * proxies `/api` to `next start`, so the page and its API share one origin.
 */
export const EDGE_PORT = Number(process.env.SHOP_E2E_PORT ?? DEFAULT_BASE_PORT);

/** `next start`. Nothing in the browser ever addresses it directly. */
export const WEB_PORT = Number(process.env.SHOP_E2E_WEB_PORT ?? DEFAULT_BASE_PORT + 1);

/** The fake WeChat Pay gateway. */
export const GATEWAY_PORT = Number(process.env.SHOP_E2E_GATEWAY_PORT ?? DEFAULT_BASE_PORT + 2);

/** Opt-in: attach to a stack already answering on `EDGE_PORT` instead of starting one. */
export const REUSE = process.env.SHOP_E2E_REUSE === '1';

export const BASE_URL = process.env.SHOP_E2E_BASE_URL ?? `http://127.0.0.1:${EDGE_PORT}`;

export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/** A seeded identity. Passwords are fixtures and exist only in a throwaway database. */
export interface SeededUser {
  id: number;
  account: string;
  phone: string;
  password: string;
  nickname: string;
}

/** Everything the specs need that only the serve script can know. */
export interface StackInfo {
  /** The database the web server and the worker are talking to. */
  databaseUrl: string;
  /** The Redis they are talking to, including the logical db index. */
  redisUrl: string;
  /** The edge — what the browser opens. */
  baseUrl: string;
  /** Where uploads land, so a spec can assert a file really was written. */
  uploadsDir: string;
  /** The fake WeChat Pay gateway's origin. */
  gatewayUrl: string;
  /** The fake mini-program's app id: what a `wechat_mini` payment is charged to. */
  wechatMiniAppId: string;
  /** The gateway control-plane's origin (`src/gateway-control.ts`) — how a
   * spec, running in a different process than the gateway, drives
   * `markPaid`/`postNotify` and `markRefunded`/`postRefundNotify`. */
  gatewayControlUrl: string;
  /** The super admin, for the `/admin-api` half of the ship and refund journeys. */
  admin: { account: string; password: string; id: number };
  /** The shopper, and the second shopper the group-buy journey needs. */
  users: { primary: SeededUser; secondary: SeededUser };
  /** Seeded ids the specs address by name instead of by guessing. */
  fixtures: StackFixtures;
}

export interface StackFixtures {
  categoryId: number;
  /** A multi-spec product: two specs, four SKUs, free freight. */
  multiSpecProductId: number;
  multiSpecSkuIds: number[];
  /** A single-SKU product behind a fixed-postage freight template. */
  postageProductId: number;
  postageSkuId: number;
  postageFreightTemplateId: number;
  /** The product both activities are attached to. */
  activityProductId: number;
  activitySkuId: number;
  couponTemplateId: number;
  groupBuyActivityId: number;
  presaleActivityId: number;
  primaryAddressId: number;
  secondaryAddressId: number;
  expressCompanyId: number;
  /** The mini-program's 首页 (页面装修 v2), as the seed designated it. */
  decorHomeId: number;
  /** The one province/city/district path the seed inserted: what any address must point at. */
  division: { provinceId: string; cityId: string; districtId: string };
}
