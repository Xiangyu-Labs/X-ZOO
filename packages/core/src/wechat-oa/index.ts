/**
 * The `wechat-oa` domain: everything an operator manages about the Official
 * Account, plus the callback WeChat talks to.
 *
 * ## Why this is a sibling of `wechat` and not a folder inside it
 *
 * `boundaries/no-restricted-source` resolves a cross-domain import against
 * `<domain>/index.ts`, so a nested `wechat/oa/` would either be unreachable
 * from other domains or force `wechat`'s own index to re-export half of this
 * file; `wechat` is flat for the same reason. This domain imports the WeChat
 * client through `../wechat` and nothing else.
 *
 * ## What other domains may use
 *
 * Almost nothing, deliberately. The admin services are for the route files;
 * the webhook service is for the two bare route handlers. The one genuinely
 * shared thing is `wechatOaPermissions`, which the role editor needs.
 */

import { registerAppConfigSource } from '../system';
import { wechatOaRuntimeConfig } from './wechat-oa.config';
import { registerWechatOaConfigTest } from './wechat-oa.config-test';
import { allSubscribeTemplates } from './wechat-oa.storefront.service';

export { wechatOaPermissions } from './permissions';
export { wechatOaRuntimeConfig, type WechatOaRuntimeConfig } from './wechat-oa.config';
export { oaCredentials, type OaCredentials } from './wechat-oa.credentials';

/** The callback's two halves. `apps/web` owns the routes; these own the rules. */
export {
  handleEvent,
  verifyUrl,
  type OaWebhookRequest,
  type OaWebhookResult,
} from './wechat-oa.webhook.service';

export * as wechatOaMenu from './wechat-oa.menu.service';
export * as wechatOaReply from './wechat-oa.reply.service';
export * as wechatOaMedia from './wechat-oa.media.service';
export * as wechatOaQrcode from './wechat-oa.qrcode.service';
export * as wechatOaStorefront from './wechat-oa.storefront.service';

/**
 * Wires the domain into the platform; called once per process from the gen'd
 * bootstrap.
 *
 * The one thing it registers is the subscribe-message template ids for
 * `GET /api/v1/app/config`: they are this domain's setting
 * (`wechat-oa-runtime`), and `system` may not import this domain, so the
 * answer crosses the seam as a reader — the same one
 * `GET /api/v1/wechat/subscribe-templates` uses, so the two can never disagree.
 * Not run at import, for the reason `registerWechatDomain()` gives: this module
 * can be reached while `system` is still evaluating.
 *
 * Everything else here answers requests and answers WeChat; the config group
 * and the permission atoms register as a side effect of their own modules
 * loading.
 */
export function registerWechatOaDomain(): void {
  registerWechatOaConfigTest();
  registerAppConfigSource('subscribeTemplates', {
    groups: [wechatOaRuntimeConfig.group],
    read: allSubscribeTemplates,
  });
}
