import {
  encodeScene,
  storefrontRoute,
  storefrontRouteDef,
} from '@shop/contracts/system/storefront-routes';
import type { MiniCodeResult, ShareMiniCodeQuery } from '@shop/contracts/wechat/schemas';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { enforce, fixedWindow } from '../kernel/rate-limit';
import { isRejected, resolveStorage, sniffFileType } from '../storage';
import { wechatMiniConfig, type MiniCodeEnvVersion } from '../system';
import { getWechatClient } from './wechat.client';
import { wechatConfig } from './wechat.config';
import * as repo from './wechat.mini-code.repo';

/**
 * 小程序码 — `wxa/getwxacodeunlimit`, generated once and served from our own
 * storage afterwards.
 *
 * Three properties, in the order they matter:
 *
 *  1. **The pair `(page, scene)` is the cache key**, because WeChat's answer
 *     for a pair never changes. Asking WeChat on every render of every poster,
 *     a shop with one product on the home screen could spend a day's quota
 *     before lunch and then show broken images to everybody.
 *  2. **The bytes are ours.** The response is stored through the storage
 *     driver and the shopper is handed a URL on the shop's own host. WeChat's
 *     own image URLs expire; a poster generated for a WeChat Moment does not.
 *  3. **A refusal is a refusal, not a stored error.** These endpoints answer
 *     200 with a JSON `errcode` body when they say no, so a client that
 *     assumed a file would cache a 43-byte "invalid page" as a PNG for ever.
 *     `callBytes` tells the two apart and this service turns the second into
 *     `WECHAT_MINI_CODE_FAILED` (502) carrying WeChat's number.
 *
 * **Which version a code opens** is `wechat-mini.codeEnvVersion` (`env_version`:
 * `release`, the default, or `trial` / `develop` for a staging install that
 * previews unreleased pages on 体验版). WeChat's answer depends on it, so it is
 * part of the cache key: a code minted for `trial` is never served once the
 * setting says `release`, and back. The table's unique key stays `(page,
 * scene)` — the previous image, which a rollback runs, inserts with
 * `ON CONFLICT (page, scene)` and needs exactly that index — so a non-release
 * code is cached under the page `<env>:<page>` (`cachePage`). No real page
 * contains a colon, so the two never collide, and a rolled-back image simply
 * never looks those rows up.
 */

/** Where the generated PNGs live under the storage root. */
const DIRECTORY = 'wechat-mini-code';

/** A year: the bytes for a pair never change, so the URL is immutable. */
const CACHE_MAX_AGE_SEC = 365 * 24 * 60 * 60;

/**
 * New codes one account may mint per hour.
 *
 * A cached pair is free and stays free. A *new* pair costs a
 * `wxa/getwxacodeunlimit` call, a PNG in the storage root and a row, and the
 * scene is any 32 bytes the caller likes — so without a budget one free account
 * could grow the uploads volume and spend the mini program's API rate at will.
 * A poster page asks once per product; thirty an hour is generous.
 */
const MINT_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Spends one mint from the caller's hourly budget, or throws `RATE_LIMITED`.
 *
 * Keyed on the account: the route is `auth: 'user'`, so there always is one. A
 * job or an admin tool calling the service has no shopper to charge and is not
 * the abuse this bounds.
 */
async function spendMint(ctx: Ctx): Promise<void> {
  const actor = ctx.actor;
  if (actor.kind !== 'user') return;
  await enforce(
    fixedWindow(ctx.redis, {
      key: `wechat:mini-code:mint:u:${actor.id}`,
      limit: MINT_PER_HOUR,
      windowMs: HOUR_MS,
      nowMs: ctx.clock.now().getTime(),
    }),
  );
}

/** The page column a code is cached under: the page itself for `release`, `<env>:<page>` otherwise. */
export function cachePage(page: string, env: MiniCodeEnvVersion): string {
  return env === 'release' ? page : `${env}:${page}`;
}

async function miniConfigured(ctx: Ctx): Promise<boolean> {
  const [mini, core] = await Promise.all([
    ctx.config.get(wechatMiniConfig),
    ctx.config.get(wechatConfig),
  ]);
  return mini.enabled && core.miniAppId.trim() !== '' && core.miniAppSecret.trim() !== '';
}

/**
 * The code for a route-catalogue key: `GET /api/v1/share/mini-codes`.
 *
 * The page is the catalogue's and the scene is `encodeScene`'s, so a caller
 * names only what it shares. The params are validated against the key (the
 * catalogue's params are strict) before anything is looked up or minted: a
 * code for `home` that carries an `id` is refused, not generated with the
 * `id` silently dropped.
 */
export async function shareMiniCodeUrl(
  ctx: Ctx,
  query: ShareMiniCodeQuery,
): Promise<MiniCodeResult> {
  const params = query.id === undefined ? {} : { id: query.id };
  const parsed = storefrontRoute.safeParse({ route: query.route, params });
  if (!parsed.success || !storefrontRouteDef(query.route).miniCode) {
    throw new DomainError('VALIDATION_FAILED', {
      details: [{ field: 'id', message: `${query.route} 页面的参数不正确` }],
    });
  }
  let scene: string;
  try {
    scene = encodeScene(parsed.data);
  } catch (error) {
    // Every `miniCode` key's scene fits by construction (its test proves it);
    // reaching this is a catalogue change that broke that, not a bad request.
    ctx.logger.error({ err: error, route: query.route }, '小程序码 scene 无法编码');
    throw new DomainError('VALIDATION_FAILED', {
      details: [{ field: 'route', message: `${query.route} 无法生成小程序码` }],
    });
  }
  return mintOrReuse(ctx, { page: storefrontRouteDef(query.route).path, scene });
}

/** The cached code for `(page, scene)`, or a new one minted and stored. */
async function mintOrReuse(
  ctx: Ctx,
  key: { page: string; scene: string },
): Promise<MiniCodeResult> {
  const { scene } = key;
  const env = (await ctx.config.get(wechatMiniConfig)).codeEnvVersion;
  const cacheKey = { page: cachePage(key.page, env), scene };
  const cached = await repo.findByPageScene(ctx.db, cacheKey);
  if (cached) return { url: cached.url };

  if (!(await miniConfigured(ctx))) throw new DomainError('AUTH_WECHAT_NOT_CONFIGURED');
  await spendMint(ctx);

  const result = await getWechatClient(ctx).callBytes('mini', {
    method: 'POST',
    path: '/wxa/getwxacodeunlimit',
    // `check_path: false` — the page is the route catalogue's own and a
    // shop generating a poster before the version carrying that page is
    // published is a normal Tuesday, not an error worth failing the share on.
    body: { page: key.page, scene, check_path: false, env_version: env },
  });

  if (!result.ok) {
    ctx.logger.warn(
      { page: key.page, errcode: result.errcode, errmsg: result.errmsg },
      '小程序码生成失败',
    );
    // The shopper reads the registry's sentence; the errcode is for whoever
    // reads the response, and WeChat's errmsg stays in the log above.
    throw new DomainError('WECHAT_MINI_CODE_FAILED', { details: { errcode: result.errcode } });
  }

  // WeChat said it is a file; the bytes say what kind. An image we cannot
  // identify is not going into the storage root under a `.png` name.
  const sniffed = sniffFileType(result.bytes, result.contentType);
  if (isRejected(sniffed) || sniffed.kind !== 'image') {
    ctx.logger.warn({ page: key.page, contentType: result.contentType }, '小程序码返回的不是图片');
    throw new DomainError('WECHAT_MINI_CODE_FAILED', { details: { errcode: 0 } });
  }

  const { storage } = await resolveStorage(ctx);
  const stored = await storage.put(result.bytes, {
    directory: DIRECTORY,
    filename: `code.${sniffed.extension}`,
    contentType: sniffed.mime,
    maxAge: CACHE_MAX_AGE_SEC,
  });

  const written = await repo.insertIgnoringConflict(ctx.db, {
    ...cacheKey,
    storageKey: stored.key,
    url: storage.url(stored.key),
  });

  if (!written.inserted && written.row.storageKey !== stored.key) {
    // Somebody else won the race with an identical picture. Ours is an orphan
    // no row points at, and leaving it behind would grow the uploads directory
    // by one file per collision for ever.
    await storage.delete(stored.key).catch((error: unknown) => {
      ctx.logger.warn({ err: error, key: stored.key }, '未能删除重复的小程序码');
    });
  }

  return { url: written.row.url };
}
