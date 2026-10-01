import type { NotificationChannel } from '@shop/contracts/notification/schemas';
import { toMiniPath } from '@shop/contracts/system/storefront-routes';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { publicOrigin } from '../system';
import { findOpenid, getWechatClient, wechatErrcodeHint } from '../wechat';
import { notificationConfig } from './notification.config';
import { CHANNEL_LABELS, missingFields } from './notification.channels';
import { resolveSmsPort } from './notification.ports';
import type { NotificationChannels } from './notification.repo';
import type { NotificationEvent } from './notification.registry';
import {
  render,
  renderFields,
  renderRoute,
  renderSmsParams,
  renderSubscribeFields,
  toTemplateData,
} from './notification.render';

/**
 * The outbound half of a fan-out: one function per channel, each returning an
 * outcome instead of throwing.
 *
 * Three rules hold for all of them, and they are the whole reason this file is
 * separate from the service:
 *
 * 1. **A channel never throws.** It returns `sent`, `skipped` or `failed`. The
 *    caller decides what a failure means for the effect as a whole; a throw
 *    here would abort the channels that come after it, so one missing openid
 *    would also lose the SMS.
 * 2. **`skipped` is not `failed`.** No openid, no phone, no provider, template
 *    not configured — none of these is a fault to retry, and treating them as
 *    failures would park an effect row per order for an operator who cannot do
 *    anything about it. Only a *transport* failure or a WeChat error code that
 *    can plausibly clear is `failed`.
 * 3. **Nothing here writes to the database.** The in-app channel is the
 *    exception and it lives in the service, inside the transaction that also
 *    publishes to the bell.
 */

export type ChannelOutcome =
  | { kind: 'sent'; detail?: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string };

export interface SendContext {
  event: NotificationEvent;
  channels: NotificationChannels;
  /** The recipient. `null` for admin-audience events, which have no WeChat identity. */
  userId: number | null;
  /** Flattened event payload, ready for `{{…}}` substitution. */
  data: Record<string, string>;
}

/**
 * Turns the event's `link` into something a WeChat message can open.
 *
 * A relative path is joined onto `site.publicOrigin`; an absolute URL is left
 * alone. With no origin configured the link is dropped rather than sent as a
 * bare path, because WeChat renders an unopenable link as a dead blue word and
 * the customer taps it anyway.
 */
export function absoluteLink(baseUrl: string, link: string | undefined): string | undefined {
  if (link === undefined || link === '') return undefined;
  if (/^https?:\/\//i.test(link)) return link;
  const base = baseUrl.replace(/\/+$/, '');
  if (base === '') return undefined;
  return `${base}${link.startsWith('/') ? '' : '/'}${link}`;
}

// ---------------------------------------------------------------------------
// OA template message
// ---------------------------------------------------------------------------

export async function sendWechatOa(ctx: Ctx, input: SendContext): Promise<ChannelOutcome> {
  const config = input.channels.wechatOa;
  if (!config?.enabled) return { kind: 'skipped', reason: 'channel disabled' };
  const templateId = config.templateId ?? '';
  if (missingFields('wechatOa', config).includes('templateId')) {
    return { kind: 'skipped', reason: 'no template id' };
  }
  if (input.userId === null) return { kind: 'skipped', reason: 'no user' };

  const openid = await findOpenid(ctx.db, input.userId, 'oa');
  if (openid === null) return { kind: 'skipped', reason: 'user has no oa openid' };

  const url = absoluteLink(
    await publicOrigin(ctx),
    render(config.linkUrl ?? input.event.link ?? '', input.data),
  );

  const fields = renderFields(config.fields, input.data);
  if (Object.keys(fields).length === 0) {
    // WeChat refuses a template message with an empty `data` object
    // (`errcode 40003`-adjacent), and there is genuinely nothing to say.
    return { kind: 'skipped', reason: 'no rendered fields' };
  }

  const result = await getWechatClient(ctx).sendTemplateMessage({
    touser: openid,
    templateId,
    ...(url === undefined ? {} : { url }),
    data: fields,
  });
  return classify(result, 'wechatOa');
}

// ---------------------------------------------------------------------------
// mini-program subscribe message
// ---------------------------------------------------------------------------

export async function sendWechatMini(ctx: Ctx, input: SendContext): Promise<ChannelOutcome> {
  const config = input.channels.wechatMini;
  if (!config?.enabled) return { kind: 'skipped', reason: 'channel disabled' };
  const templateId = config.templateId ?? '';
  if (missingFields('wechatMini', config).includes('templateId')) {
    return { kind: 'skipped', reason: 'no template id' };
  }
  if (input.userId === null) return { kind: 'skipped', reason: 'no user' };

  const openid = await findOpenid(ctx.db, input.userId, 'mini');
  if (openid === null) return { kind: 'skipped', reason: 'user has no mini openid' };

  const { miniProgramState } = await ctx.config.get(notificationConfig);
  // Fitted to each field's type: one over-long `thing` fails the whole message.
  const fields = renderSubscribeFields(config.fields, input.data);
  if (Object.keys(fields).length === 0) return { kind: 'skipped', reason: 'no rendered fields' };

  const page = subscribePage(input);
  const result = await getWechatClient(ctx).sendSubscribeMessage({
    touser: openid,
    templateId,
    ...(page === '' ? {} : { page }),
    miniprogramState: miniProgramState,
    data: fields,
  });
  return classify(result, 'wechatMini');
}

/**
 * The subscribe message's `page`: the event's catalogue route through
 * `toMiniPath` (docs/mini/pages.md §3.4). An event without a route, or a route
 * that does not render (a missing variable), sends the message without a page
 * — WeChat then opens the home page — rather than guessing.
 */
function subscribePage(input: SendContext): string {
  if (!input.event.route) return '';
  const route = renderRoute(input.event.route, input.data);
  return route ? toMiniPath(route) : '';
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

export async function sendSms(ctx: Ctx, input: SendContext): Promise<ChannelOutcome> {
  const config = input.channels.sms;
  if (!config?.enabled) return { kind: 'skipped', reason: 'channel disabled' };
  // A row written around the save may have no code at all, not just an empty one.
  if (missingFields('sms', config).length > 0) {
    return { kind: 'skipped', reason: 'no template code' };
  }
  if (input.userId === null) return { kind: 'skipped', reason: 'no user' };

  const port = resolveSmsPort();
  if (!port) return { kind: 'skipped', reason: 'no sms provider registered' };

  const result = await port.send(ctx, {
    userId: input.userId,
    templateCode: config.templateCode,
    ...(config.signName ? { signName: config.signName } : {}),
    params: renderSmsParams(config.params, input.data),
    notificationCode: input.event.code,
  });
  if (result.ok) return { kind: 'sent' };
  if (result.skipped) return { kind: 'skipped', reason: result.skipped };
  return {
    kind: 'failed',
    reason: `sms ${result.errorCode ?? ''} ${result.errorMessage ?? ''}`.trim(),
  };
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/**
 * WeChat error codes that will never clear by trying again.
 *
 * Retrying these costs eight attempts and half an hour of backoff and then
 * parks a row for an operator whose only possible action is "ignore it":
 *
 * - `43004` the user has not followed the account
 * - `43101` the user turned this template off (OA) / refused the subscription
 * - `40003` invalid openid — the identity row is stale
 * - `47003` a field failed the template's own type check, which is a
 *   configuration mistake, not a transient one
 * - `43116`/`43102` the subscription was used up or the template was deleted
 */
const PERMANENT_WECHAT_ERRORS = new Set([40003, 43004, 43101, 43102, 43116, 47003]);

function classify(
  result: { ok: boolean; errcode: number; errmsg: string },
  channel: NotificationChannel,
): ChannelOutcome {
  if (result.ok) return { kind: 'sent' };
  if (PERMANENT_WECHAT_ERRORS.has(result.errcode)) {
    return { kind: 'skipped', reason: `${channel} ${result.errcode}: ${result.errmsg}` };
  }
  return { kind: 'failed', reason: `${channel} ${result.errcode}: ${result.errmsg}` };
}

/**
 * What a channel that *threw* amounts to.
 *
 * The WeChat client returns a business refusal and throws for two things: a
 * transport failure, which a retry fixes, and a refused token (`/cgi-bin/token`
 * answering 40125 for a wrong AppSecret, 40164 for an IP off the whitelist),
 * which a retry does not. The second used to be filed with the first and read
 * 网络或对方服务暂时不可用. A refused token carries the errcode in `details`, so
 * it is written the way `classify` writes a refusal and is explained from the
 * same tables; an account with no AppID or AppSecret is a configuration the
 * operator fills in, so it is `skipped` like the other missing settings.
 */
export function outcomeOfThrown(channel: NotificationChannel, error: unknown): ChannelOutcome {
  if (error instanceof DomainError) {
    if (error.code === 'WECHAT_OA_NOT_CONFIGURED' || error.code === 'AUTH_WECHAT_NOT_CONFIGURED') {
      return { kind: 'skipped', reason: 'wechat not configured' };
    }
    const errcode = (error.details as { errcode?: unknown } | undefined)?.errcode;
    if ((channel === 'wechatOa' || channel === 'wechatMini') && typeof errcode === 'number') {
      return { kind: 'failed', reason: `${channel} ${errcode}: ${error.message}` };
    }
  }
  return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
}

// ---------------------------------------------------------------------------
// reasons, in the operator's words
// ---------------------------------------------------------------------------

/** The in-app channel's `failed` reason; the database's own error goes to the log. */
export const IN_APP_WRITE_FAILED = 'in-app write failed';

/**
 * Every `skipped` reason this file and the fan-out produce, as an operator
 * would put it. 测试发送 and 发送记录 both read it; a reason missing here
 * reaches the screen as a generic sentence, never as the English.
 */
const SKIP_REASONS: Record<string, string> = {
  'channel disabled': '该渠道没有开启',
  'template disabled': '该通知已停用',
  'no user': '没有可以接收的会员',
  'no admin recipients': '没有哪个管理员有接收这条通知的权限',
  'no template id': '还没填模板 ID',
  'no template code': '还没填短信模板编号',
  'user has no oa openid': '该会员没有关注公众号或没有公众号授权记录',
  'user has no mini openid': '该会员没有用过小程序，没有小程序授权记录',
  'wechat not configured':
    '公众号或小程序还没填 AppID 和 AppSecret（系统设置 → 微信公众号 / 小程序）',
  'no rendered fields': '字段映射渲染后全是空的，没有可发送的内容',
  'no sms provider registered': '没有配置短信服务商（系统设置 → 短信）',
  'user has no phone': '该会员没有绑定手机号',
  [IN_APP_WRITE_FAILED]: '站内信没能写入（数据库暂时不可用）',
};

/**
 * WeChat's codes an operator meets when a message is refused, in their words.
 * The token and configuration codes (AppSecret, IP whitelist…) are in
 * `wechat.errcodes.ts`, which `explainChannelReason` falls back to.
 */
const WECHAT_CODES: Record<number, string> = {
  40003: '该会员的微信授权记录无效，可能已过期',
  40037: '模板 ID 不对，请到公众平台核对',
  41030: '跳转页面不存在，小程序可能还没发布这个页面',
  43004: '该会员没有关注公众号',
  43101: '该会员没有订阅这条消息——小程序订阅消息要用户先在小程序里点过「允许」',
  43102: '模板已被删除或停用',
  43116: '模板已被删除或停用',
  47003: '字段内容不符合模板要求，看看预览里的提示',
};

/**
 * The SMS providers' refusals an operator actually meets while setting up a
 * template, in their words. The provider's own message (often English) stays
 * in the log; the operator gets this and the code.
 */
const SMS_CODES: Record<string, string> = {
  'FailedOperation.TemplateParamSetNotMatchApprovedTemplate':
    '变量个数和审核通过的模板不一致：模板里有几个 {1}{2}…，这里就要按顺序填几个变量，没有变量就一个都不填',
  'InvalidParameterValue.TemplateParameterLengthLimit':
    '有变量超过腾讯云的长度限制（验证码以外的变量最多 6 个字）',
  'InvalidParameterValue.TemplateParameterFormatError': '变量格式不符合模板要求',
  'FailedOperation.TemplateIncorrectOrUnapproved': '模板 ID 不对，或模板还没审核通过',
  'FailedOperation.SignatureIncorrectOrUnapproved': '签名不对，或签名还没审核通过',
  'FailedOperation.InsufficientBalanceInSmsPackage': '短信套餐包余量不足',
  'FailedOperation.PhoneNumberInBlacklist': '该手机号退订过或在服务商的黑名单里',
  'LimitExceeded.PhoneNumberDailyLimit': '该手机号今天收到的短信太多，被服务商限流',
  'LimitExceeded.PhoneNumberOneHourLimit': '该手机号一小时内收到的短信太多，被服务商限流',
  'LimitExceeded.PhoneNumberThirtySecondLimit': '该手机号 30 秒内收到的短信太多，被服务商限流',
  'isv.TEMPLATE_MISSING_PARAMETERS': '缺少模板变量：变量名要和阿里云模板里的 ${…} 一一对应',
  'isv.SMS_TEMPLATE_ILLEGAL': '模板编号不对，或模板还没审核通过',
  'isv.SMS_SIGNATURE_ILLEGAL': '签名不对，或签名还没审核通过',
  'isv.SIGN_NAME_ILLEGAL': '签名不对，或签名还没审核通过',
  'isv.AMOUNT_NOT_ENOUGH': '短信账户余额不足',
  'isv.BUSINESS_LIMIT_CONTROL': '该手机号收到的短信太多，被服务商限流',
  'isv.PARAM_LENGTH_LIMIT': '有变量超过阿里云的长度限制',
  PARAM_NAME_MISSING: '有变量没填变量名，阿里云按变量名填模板',
  TRANSPORT: '连不上短信服务商，请稍后再试',
};

/**
 * The WeChat error code of a reason `classify` wrote (`wechatOa 43004: …`), if
 * it is one. Anchored to that shape: a transport error that happens to hold
 * five digits (`getaddrinfo ENOTFOUND api 40003`) is not WeChat's answer.
 */
export function wechatCode(reason: string): number | null {
  const code = /^wechat(?:Oa|Mini) (-?\d+):/.exec(reason)?.[1];
  return code === undefined ? null : Number(code);
}

/** The provider's code of a reason `sendSms` wrote (`sms <code> <provider message>`), if it is one. */
export function smsCode(reason: string): string | null {
  return /^sms (\S+)/.exec(reason)?.[1] ?? null;
}

/**
 * A channel's `skipped` or `failed` reason in the operator's words, with the
 * gateway's code for whoever they ask for help, or `null` when it is not one we
 * know (a transport error, a code missing from the tables).
 */
export function explainChannelReason(reason: string): string | null {
  const known = SKIP_REASONS[reason];
  if (known !== undefined) return known;
  const wechat = wechatCode(reason);
  if (wechat !== null) {
    const text = WECHAT_CODES[wechat] ?? wechatErrcodeHint(wechat);
    return text === undefined ? null : `${text}（错误码 ${wechat}）`;
  }
  const sms = smsCode(reason);
  if (sms !== null) {
    const text = SMS_CODES[sms];
    return text === undefined ? null : `${text}（${sms}）`;
  }
  return null;
}

/**
 * A `skipped` reason in the operator's words, always: a known one as they would
 * put it, an unknown WeChat refusal as its bare code, anything else plainly.
 */
export function explainSkip(reason: string): string {
  const known = explainChannelReason(reason);
  if (known !== null) return known;
  const code = wechatCode(reason);
  return code === null ? '没有发出' : `微信拒收了这条消息（错误码 ${code}）`;
}

/**
 * A `failed` reason in the operator's words, always. A failure is either a
 * code WeChat or the SMS provider answered with (a refused token included, see
 * `outcomeOfThrown`), or a throw from the transport, so what is not recognised
 * is the network.
 * The provider's own text stays in the effect's outcome and the service log.
 */
export function explainFailure(reason: string): string {
  const known = explainChannelReason(reason);
  if (known !== null) return known;
  const wechat = wechatCode(reason);
  if (wechat !== null) return `微信返回错误码 ${wechat}`;
  const sms = smsCode(reason);
  if (sms !== null) return `短信服务商拒绝发送（${sms}）`;
  return '网络或对方服务暂时不可用，没能发出';
}

/**
 * A fan-out's failed channels in the operator's words, as 发送记录 shows them:
 * `公众号：模板 ID 不对，请到公众平台核对（错误码 40037）；短信：…`.
 */
export function failedChannelsInWords(
  failed: readonly { channel: NotificationChannel; reason: string }[],
): string {
  return failed
    .map(({ channel, reason }) => `${CHANNEL_LABELS[channel]}：${explainFailure(reason)}`)
    .join('；');
}

/** Renders the in-app title and body, falling back to the registry's defaults. */
export function renderInApp(
  event: NotificationEvent,
  channels: NotificationChannels,
  data: Record<string, string>,
): { title: string; content: string } {
  const config = channels.inApp;
  const title = render(config?.title || event.defaults.title, data);
  const content = render(config?.body || event.defaults.body, data);
  return { title, content };
}

export { toTemplateData };
