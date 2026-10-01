/**
 * The server-side plumbing every `route.ts` uses.
 *
 * Route files import from here and nothing else:
 *
 *     import { handle } from '@/server';
 *     export const POST = handle(coupon.adminCreate, (ctx, { body }) =>
 *       couponService.create(ctx, body));
 */
export {
  handle,
  ADMIN_COOKIE,
  adminCookieMaxAge,
  checkCsrf,
  readCookie,
  searchParamsToObject,
} from './handle';
export type {
  CookieOptions,
  HandleOptions,
  NextRouteContext,
  RequestCtx,
  RouteHandler,
  RouteInput,
} from './handle';
export { healthPayload } from './health';
export { buildContainer, getContainer, setContainer, type Container } from './container';
export { loadEnv, resetEnv, isProduction, envSchema, type Env } from './env';
