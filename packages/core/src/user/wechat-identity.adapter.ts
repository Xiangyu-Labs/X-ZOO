import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { getWechatClient, wechatRefusal } from '../wechat';
import type { WechatIdentityPort } from './wechat-identity.port';

/**
 * `WechatIdentityPort` over the `wechat` domain's `WechatCoreClient`
 * (`core/src/wechat/`).
 *
 * The client reports a failed exchange as `DomainError('INTERNAL')` carrying
 * WeChat's `errcode` in `details`; the sign-in service must never see a number,
 * so the codes that mean "this code is spent or forged" become
 * `AUTH_WECHAT_CODE_INVALID` here and everything else stays what it was — a
 * misconfigured secret or a WeChat outage is an incident, not a login refusal.
 *
 * `miniPhoneNumber` has no method on the client; it goes through the generic
 * `call('mini', …)`, which injects the mini-program access token.
 */

/** 40029 invalid code · 40163 code been used · 41008 missing code · 40226 high-risk user. */
const CODE_INVALID = new Set([40029, 40163, 41008, 40226]);

function asCodeRefusal(error: unknown): never {
  if (error instanceof DomainError) {
    const errcode = (error.details as { errcode?: unknown } | undefined)?.errcode;
    if (typeof errcode === 'number' && CODE_INVALID.has(errcode)) {
      throw new DomainError('AUTH_WECHAT_CODE_INVALID', { cause: error });
    }
  }
  throw error;
}

interface PhoneNumberEnvelope {
  errcode?: number;
  errmsg?: string;
  phone_info?: { phoneNumber?: string; purePhoneNumber?: string; countryCode?: string };
}

export const wechatIdentityAdapter: WechatIdentityPort = {
  async miniCodeToSession(ctx: Ctx, code: string) {
    const session = await getWechatClient(ctx).miniCode2Session(code).catch(asCodeRefusal);
    return {
      openid: session.openid,
      unionid: session.unionid,
      sessionKey: session.sessionKey,
    };
  },

  async miniPhoneNumber(ctx: Ctx, code: string) {
    const body = await getWechatClient(ctx)
      .call<PhoneNumberEnvelope>('mini', {
        method: 'POST',
        path: '/wxa/business/getuserphonenumber',
        body: { code },
      })
      .catch(asCodeRefusal);
    const info = body.phone_info;
    // `purePhoneNumber` is the number without the country code — what we store.
    const phone = info?.purePhoneNumber ?? info?.phoneNumber;
    if ((body.errcode ?? 0) !== 0 || !phone) {
      if (CODE_INVALID.has(body.errcode ?? 0)) throw new DomainError('AUTH_WECHAT_CODE_INVALID');
      // WeChat's errmsg is for the log (AGENTS rule 1); the message says what
      // failed, and the errcode.
      ctx.logger.warn(
        { errcode: body.errcode, errmsg: body.errmsg },
        'wechat getuserphonenumber refused',
      );
      throw new DomainError('INTERNAL', {
        message: wechatRefusal('获取微信手机号失败', body.errcode),
        details: { errcode: body.errcode ?? null },
      });
    }
    return { phone, countryCode: info?.countryCode };
  },

  async oaCodeToUser(ctx: Ctx, code: string) {
    const client = getWechatClient(ctx);
    const exchange = await client.oaCodeExchange(code).catch(asCodeRefusal);
    if (!exchange.scope.includes('snsapi_userinfo')) {
      return { openid: exchange.openid, unionid: exchange.unionid };
    }
    const profile = await client.oaUserInfo({
      accessToken: exchange.accessToken,
      openid: exchange.openid,
    });
    return {
      openid: profile.openid,
      unionid: profile.unionid ?? exchange.unionid,
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl,
    };
  },
};
