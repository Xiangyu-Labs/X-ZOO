import { registerConfigTest, testSteps } from '../kernel/config-test';
import { probeWechatCredentials } from './wechat.client';
import { wechatConfig } from './wechat.config';
import { wechatRefusal } from './wechat.errcodes';

/**
 * 微信公众号 / 小程序 → 「测试 AppSecret」.
 *
 * Gets a token for each app that has an AppID filled in. That one call checks
 * the AppID, the AppSecret and the IP whitelist together, and those three are
 * why a login or a message fails. The token is not kept.
 */
export function registerWechatConfigTest(): void {
  registerConfigTest(wechatConfig, {
    label: '测试 AppSecret',
    async run(ctx, config) {
      const t = testSteps(ctx);
      const apps = [
        { name: '公众号', appId: config.oaAppId.trim(), secret: config.oaAppSecret.trim() },
        { name: '小程序', appId: config.miniAppId.trim(), secret: config.miniAppSecret.trim() },
      ].filter((app) => app.appId !== '');

      if (apps.length === 0) {
        t.fail('检查配置', '公众号和小程序的 AppID 都没有填写');
        return t.result();
      }
      for (const app of apps) {
        await t.step(`${app.name}：获取 access_token`, async () => {
          if (app.secret === '') throw new Error(`没有填写${app.name} AppSecret`);
          const answer = await probeWechatCredentials({
            apiBaseUrl: config.apiBaseUrl,
            appId: app.appId,
            secret: app.secret,
          }).catch((error: unknown) => {
            // `fetch failed` is not something to show anybody; the cause is in the log.
            ctx.logger.warn(
              { err: error, app: app.name },
              'wechat credential probe did not connect',
            );
            throw new Error('连不上微信接口，请检查服务器的网络后再试');
          });
          if (!answer.ok) {
            // WeChat's errmsg is English with a request id: the log keeps it,
            // the screen gets what the errcode means and the code itself.
            ctx.logger.warn(
              { app: app.name, errcode: answer.errcode, errmsg: answer.errmsg },
              'wechat credential probe refused',
            );
            throw new Error(
              answer.errcode < 0
                ? '微信接口暂时不可用，请稍后再试'
                : wechatRefusal('微信拒绝了这次请求', answer.errcode),
            );
          }
          return `AppID ${app.appId} 与 AppSecret 匹配，本服务器 IP 已在白名单内`;
        });
      }
      return t.result();
    },
  });
}
