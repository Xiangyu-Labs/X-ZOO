import { authOaAuthorizeUrl } from '@shop/contracts/auth/auth.storefront.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../../src/server';

/**
 * `GET /api/v1/auth/wechat-oa/authorize-url` — where to send the browser.
 *
 * The `redirectUrl` is checked against the configured site origin before it is
 * handed to WeChat; an unchecked one gives the sign-in `code` to whoever asked.
 */
export const GET = handle(authOaAuthorizeUrl, (ctx, { query }) => user.oaAuthorizeUrl(ctx, query));

export const dynamic = 'force-dynamic';
