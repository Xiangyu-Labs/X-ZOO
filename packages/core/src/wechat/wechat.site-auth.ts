import type { Ctx } from '../kernel/context';
import { wechatMiniConfig, wechatOaConfig } from '../system';
import { wechatConfig } from './wechat.config';

/**
 * 公众号 and mini-program sign-in on `GET /api/v1/app/config`.
 *
 * The app reads these to decide where a signed-out shopper goes. A method is offered only when it can
 * actually sign someone in:
 *
 * - the operator's 启用 switch (`wechat-oa.enabled` / `wechat-mini.enabled`),
 *   which sign-in's `oaApp` / `miniApp` refuse without
 *   (`AUTH_WECHAT_NOT_CONFIGURED`);
 * - the app id **and** the secret in this domain's `wechat` group — the code
 *   exchange needs both, which is what `wechat_status` means: "appid and
 *   appsecret are not blank".
 *
 * Only booleans leave this file. `registerWechatDomain()` hands the probes to
 * `system`, which may not import `wechat` back (`wechat.mini-code.service.ts`
 * and `payment` both sit between them).
 */

export async function wechatOaLoginUsable(ctx: Ctx): Promise<boolean> {
  const [oa, core] = await Promise.all([
    ctx.config.get(wechatOaConfig),
    ctx.config.get(wechatConfig),
  ]);
  return oa.enabled && core.oaAppId.trim() !== '' && core.oaAppSecret.trim() !== '';
}

export async function wechatMiniLoginUsable(ctx: Ctx): Promise<boolean> {
  const [mini, core] = await Promise.all([
    ctx.config.get(wechatMiniConfig),
    ctx.config.get(wechatConfig),
  ]);
  return mini.enabled && core.miniAppId.trim() !== '' && core.miniAppSecret.trim() !== '';
}
