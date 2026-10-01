import { randomUUID } from 'node:crypto';
import { anonymousActor, createCtx, type Ctx } from '@shop/core/kernel';
import { siteConfig, wechatMiniConfig } from '@shop/core/system';
import { shareMiniCodeUrl, wechatConfig } from '@shop/core/wechat';
import { getContainer } from './container';

/**
 * What the landing page at `/` shows (`app/page.tsx`): the shop's name, the
 * 小程序码 for the home page, and the 备案 lines a Chinese site's front page
 * must carry. After the cutover `/` is this page and nothing else — the uni-app
 * H5 is gone, the shop lives in the mini-program (docs/mini/cutover.md §2.10).
 *
 * The page is public and anonymous, so the code is fetched with care:
 *
 *  - **Only when WeChat is configured** (the mini-program switched on, AppID
 *    and AppSecret present). Otherwise the page shows a text fallback and
 *    never talks to WeChat.
 *  - **Cached in Redis** for a day once known, so a page view is one Redis
 *    read, not a database query.
 *  - **One attempt at a time, and a pause after a failure.** A miss takes a
 *    short lock; a WeChat refusal (the code minted by `shareMiniCodeUrl` is
 *    cached in `wechat_mini_codes` once it succeeds) keeps the lock for ten
 *    minutes. An anonymous visitor can therefore cause at most one WeChat
 *    call per ten minutes, however often the page is loaded — the shoppers'
 *    hourly mint budget does not apply to an anonymous caller.
 *
 * Nothing here throws: a page that is the shop's front door renders its text
 * fallback rather than a 500 when Redis, the database or WeChat is down.
 */

export interface LandingLink {
  text: string;
  /** `http(s)` only; absent when the configured link is not one. */
  href?: string;
}

export interface LandingData {
  /** `null` when the settings could not be read. */
  shopName: string | null;
  /** The name to search for in WeChat: the mini-program's, else the shop's. */
  miniName: string | null;
  /** The home page's 小程序码, or `null` for the text fallback. */
  codeUrl: string | null;
  /** ICP 备案号, 公安备案号, 版权 — each only when configured. */
  footer: LandingLink[];
}

export interface LandingDeps {
  /** The home page's code (`GET /api/v1/share/mini-codes?route=home` without the session). */
  mintCode: (ctx: Ctx) => Promise<{ url: string }>;
}

const defaultDeps: LandingDeps = {
  mintCode: (ctx) => shareMiniCodeUrl(ctx, { route: 'home' }),
};

export const LANDING_CODE_KEY = 'landing:mini-code:url';
export const LANDING_LOCK_KEY = 'landing:mini-code:lock';
const CODE_TTL_SEC = 24 * 60 * 60;
const LOCK_TTL_SEC = 30;
export const LANDING_BACKOFF_SEC = 10 * 60;

const EMPTY: LandingData = { shopName: null, miniName: null, codeUrl: null, footer: [] };

/** A link as configured, or text only when it is not `http(s)`. */
function link(text: string, url: string): LandingLink {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? { text, href: trimmed } : { text };
}

export async function landingData(ctx: Ctx, deps: LandingDeps = defaultDeps): Promise<LandingData> {
  const settings = await Promise.all([
    ctx.config.get(siteConfig),
    ctx.config.get(wechatMiniConfig),
    ctx.config.get(wechatConfig),
  ]).catch((error: unknown) => {
    ctx.logger.warn({ err: error }, 'landing: settings unavailable');
    return null;
  });
  if (!settings) return EMPTY;
  const [site, mini, wechat] = settings;

  const shopName = site.siteName.trim() || null;
  const miniName = mini.name.trim() || shopName;
  const footer: LandingLink[] = [];
  if (site.icpNumber.trim()) footer.push(link(site.icpNumber.trim(), site.icpUrl));
  if (site.publicSecurityNumber.trim()) {
    footer.push(link(site.publicSecurityNumber.trim(), site.publicSecurityUrl));
  }
  if (site.copyrightText.trim()) footer.push(link(site.copyrightText.trim(), site.copyrightLink));

  const configured =
    mini.enabled && wechat.miniAppId.trim() !== '' && wechat.miniAppSecret.trim() !== '';
  const codeUrl = configured ? await homeCode(ctx, mini.codeEnvVersion, deps) : null;
  return { shopName, miniName, codeUrl, footer };
}

async function homeCode(ctx: Ctx, env: string, deps: LandingDeps): Promise<string | null> {
  // Per version: a code minted for 体验版 is never shown once the setting says 正式版.
  const cacheKey = `${LANDING_CODE_KEY}:${env}`;
  const lockKey = `${LANDING_LOCK_KEY}:${env}`;
  try {
    const cached = await ctx.redis.get(cacheKey);
    if (cached) return cached;
    const locked = await ctx.redis.set(lockKey, '1', 'EX', LOCK_TTL_SEC, 'NX');
    if (locked !== 'OK') return null;
  } catch (error) {
    ctx.logger.warn({ err: error }, 'landing: redis unavailable');
    return null;
  }

  try {
    const { url } = await deps.mintCode(ctx);
    await ctx.redis.set(cacheKey, url, 'EX', CODE_TTL_SEC);
    await ctx.redis.del(lockKey);
    return url;
  } catch (error) {
    ctx.logger.warn({ err: error }, 'landing: 小程序码 unavailable, showing the text fallback');
    // The lock stays, longer: the next attempt is one pause away.
    await ctx.redis.expire(lockKey, LANDING_BACKOFF_SEC).catch(() => undefined);
    return null;
  }
}

/** What `app/page.tsx` renders: the fallback when even the container cannot be built. */
export async function loadLanding(): Promise<LandingData> {
  let ctx: Ctx;
  try {
    ctx = landingCtx();
  } catch (error) {
    console.error('landing: no server container', error);
    return EMPTY;
  }
  return landingData(ctx);
}

/** An anonymous request context for the page, as the webhook routes build theirs. */
function landingCtx(): Ctx {
  const container = getContainer();
  const requestId = randomUUID();
  return createCtx({
    db: container.db,
    redis: container.redis,
    clock: container.clock,
    config: container.config,
    logger: container.logger.child({ requestId, routeId: 'web.landing' }),
    queue: container.queue,
    storage: container.storage,
    actor: anonymousActor,
    platform: null,
    requestId,
    routeId: 'web.landing',
  });
}
