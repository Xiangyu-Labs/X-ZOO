import {
  TENCENT_SMS_PARAM_LIMIT,
  type NotificationChannel,
  type NotificationTemplatePreview,
  type NotificationTemplatePreviewBody,
  type NotificationTestSendBody,
  type NotificationTestSendResult,
} from '@shop/contracts/notification/schemas';
import { toMiniPath } from '@shop/contracts/system/storefront-routes';
import { requirePermission } from '../auth/rbac';
import type { Ctx } from '../kernel/context';
import { requireAdminId } from '../kernel/context';
import { UNEXPLAINED } from '../kernel/error-summary';
import { DomainError } from '../kernel/errors';
import { fromId } from '../kernel/ids';
import { enforce, fixedWindow } from '../kernel/rate-limit';
import { publicOrigin, smsConfig } from '../system';
import { notificationPermissions } from './permissions';
import type { NotificationChannels } from './notification.repo';
import { findNotificationEvent, type NotificationEvent } from './notification.registry';
import {
  clampField,
  legacyPlaceholdersIn,
  placeholdersIn,
  render,
  renderFields,
  renderRoute,
  renderSmsParams,
  WECHAT_FIELD_LIMIT,
} from './notification.render';
import {
  absoluteLink,
  explainChannelReason,
  renderInApp,
  sendSms,
  sendWechatMini,
  sendWechatOa,
  smsCode,
  wechatCode,
  type ChannelOutcome,
} from './notification.send';

/**
 * 预览 and 测试发送 for the template form.
 *
 * Both take the form as it stands — saved or not — and both go through the
 * send path's own functions: the preview renders with `render`/`renderFields`/
 * `renderRoute`, the test send calls `sendWechatOa`/`sendWechatMini`/`sendSms`.
 * So what the operator sees here is what a shopper gets, and a template that
 * previews clean cannot be rejected for a reason the preview hid.
 */

export async function preview(
  ctx: Ctx,
  params: { code: string },
  body: NotificationTemplatePreviewBody,
): Promise<NotificationTemplatePreview> {
  requirePermission(ctx, notificationPermissions['template:read']);
  const event = requireEvent(params.code);
  return explainPreview({
    event,
    channels: body.channels as NotificationChannels,
    data: body.data,
    origin: await publicOrigin(ctx),
    smsProvider: (await ctx.config.get(smsConfig)).provider,
  });
}

export interface PreviewInput {
  event: NotificationEvent;
  channels: NotificationChannels;
  data: Readonly<Record<string, string>>;
  /** `site.publicOrigin`, which a relative 公众号 link is joined onto. */
  origin: string;
  /** 短信设置's provider: Tencent fills variables by position and caps each at 6 characters. */
  smsProvider: SmsProvider;
}

type SmsProvider = NonNullable<NotificationTemplatePreview['sms']>['provider'];

/**
 * The pure half of the preview: every supported channel rendered, and what
 * would go wrong. Warnings are for the channels switched on in the form — a
 * channel the shop does not use would otherwise fill the list with 还没填模板 ID.
 */
export function explainPreview(input: PreviewInput): NotificationTemplatePreview {
  const { event, channels, data } = input;
  const supports = (channel: NotificationChannel): boolean => event.channels.includes(channel);
  const warnings: string[] = [];
  const placeholders = new PlaceholderAudit(event, data);
  // Where a switched-off channel's warnings go: nowhere.
  const sinkFor = (enabled: boolean): Sink =>
    enabled ? { warnings, placeholders } : { warnings: [], placeholders: null };

  let inApp: NotificationTemplatePreview['inApp'] = null;
  if (supports('inApp')) {
    const config = channels.inApp;
    const enabled = config?.enabled ?? false;
    const sink = sinkFor(enabled);
    sink.placeholders?.scan('站内信标题', config?.title || event.defaults.title);
    sink.placeholders?.scan('站内信正文', config?.body || event.defaults.body);
    const rendered = renderInApp(event, channels, { ...data });
    inApp = { enabled, ...rendered, opens: opensOf(event, data) };
  }

  let wechatOa: NotificationTemplatePreview['wechatOa'] = null;
  if (supports('wechatOa')) {
    const config = channels.wechatOa;
    const enabled = config?.enabled ?? false;
    const sink = sinkFor(enabled);
    const templateId = config?.templateId ?? '';
    if (templateId === '') sink.warnings.push('公众号：还没填模板 ID，不会发送');
    const link = render(config?.linkUrl ?? event.link ?? '', data);
    if (config?.linkUrl) sink.placeholders?.scan('公众号跳转链接', config.linkUrl);
    const url = absoluteLink(input.origin, link) ?? null;
    if (link !== '' && url === null) {
      sink.warnings.push('公众号：跳转链接是相对路径，但站点设置里没有对外域名，发送时会去掉链接');
    }
    const fields = renderWechatFields('公众号', config?.fields, data, sink);
    wechatOa = { enabled, templateId, url, fields };
  }

  let wechatMini: NotificationTemplatePreview['wechatMini'] = null;
  if (supports('wechatMini')) {
    const config = channels.wechatMini;
    const enabled = config?.enabled ?? false;
    const sink = sinkFor(enabled);
    const templateId = config?.templateId ?? '';
    if (templateId === '') sink.warnings.push('小程序：还没填模板 ID，不会发送');
    const route = event.route ? renderRoute(event.route, data) : null;
    if (event.route && route === null) {
      sink.warnings.push('小程序：跳转页面缺少参数，消息会打开小程序首页');
    }
    const fields = renderWechatFields('小程序', config?.fields, data, sink);
    for (const field of fields) {
      const problem = subscribeFieldProblem(field.key, field.value);
      if (problem) {
        sink.warnings.push(`小程序字段 ${field.key}：${problem}，微信会拒收整条消息（47003）`);
      }
    }
    wechatMini = { enabled, templateId, page: route ? toMiniPath(route) : null, fields };
  }

  let sms: NotificationTemplatePreview['sms'] = null;
  if (supports('sms')) {
    const config = channels.sms;
    const enabled = config?.enabled ?? false;
    const sink = sinkFor(enabled);
    const provider = input.smsProvider;
    const templateCode = config?.templateCode ?? '';
    if (templateCode === '') sink.warnings.push('短信：还没填模板编号，不会发送');
    if (provider === 'none') {
      sink.warnings.push('短信：还没在「系统设置 → 短信设置」里选择服务商，不会发送');
    }
    sms = {
      enabled,
      provider,
      templateCode,
      signName: config?.signName || null,
      params: explainSmsParams(provider, config?.params ?? [], data, sink),
    };
  }

  return { inApp, wechatOa, wechatMini, sms, warnings: [...placeholders.warnings(), ...warnings] };
}

/**
 * The SMS variables exactly as `sendSms` hands them to the provider — same
 * function, same order — keyed by the slot each fills: `{1}`, `{2}` for
 * Tencent (and before a provider is chosen), the variable name for Aliyun.
 * Warns about what the provider would refuse.
 */
function explainSmsParams(
  provider: SmsProvider,
  templates: readonly { name?: string | undefined; value: string }[],
  data: Readonly<Record<string, string>>,
  { warnings, placeholders }: Sink,
): { key: string; value: string }[] {
  const rendered = renderSmsParams(templates, data);
  const seen = new Set<string>();
  return rendered.map(({ name, value }, index) => {
    const slot = `{${index + 1}}`;
    const label = provider === 'aliyun' && name !== '' ? `短信变量 ${name}` : `短信变量 ${slot}`;
    placeholders?.scan(label, templates[index]?.value ?? '');
    if (value === '') warnings.push(`${label} 渲染后为空，服务商可能拒收`);
    const length = [...value].length;
    if (provider === 'tencent' && length > TENCENT_SMS_PARAM_LIMIT) {
      warnings.push(
        `${label}「${value}」有 ${length} 个字，腾讯云限制验证码以外的变量最多 ${TENCENT_SMS_PARAM_LIMIT} 个字，会被拒收`,
      );
    }
    if (provider === 'aliyun') {
      if (name === '') {
        warnings.push(`短信第 ${index + 1} 个变量没填变量名，阿里云按变量名填模板，会发送失败`);
      } else if (seen.has(name)) {
        warnings.push(`短信变量名 ${name} 重复了，阿里云只会收到最后一个`);
      }
      seen.add(name);
    }
    const key = provider === 'aliyun' ? name || `第 ${index + 1} 个（未填变量名）` : slot;
    return { key, value };
  });
}

/** Where tapping the in-app message goes: the mini-program page, or the admin path. */
function opensOf(event: NotificationEvent, data: Readonly<Record<string, string>>): string | null {
  if (event.route) {
    const route = renderRoute(event.route, data);
    return route ? toMiniPath(route) : null;
  }
  if (event.link) return render(event.link, data) || null;
  return null;
}

interface Sink {
  warnings: string[];
  placeholders: PlaceholderAudit | null;
}

/**
 * Renders a WeChat field map the way the send does, and says what the send
 * would silently do to it: truncate a long field, drop an empty one, or send
 * nothing at all.
 */
function renderWechatFields(
  label: string,
  fields: Readonly<Record<string, string>> | undefined,
  data: Readonly<Record<string, string>>,
  { warnings, placeholders }: Sink,
): { key: string; value: string }[] {
  const entries = Object.entries(fields ?? {});
  for (const [key, template] of entries) {
    placeholders?.scan(`${label} ${key}`, template);
    const value = render(template, data);
    if (value === '') {
      warnings.push(`${label}字段 ${key} 渲染后为空，发送时会被去掉`);
    } else if (clampField(value) !== value) {
      warnings.push(`${label}字段 ${key} 超过 ${WECHAT_FIELD_LIMIT} 字，发送时会被截断`);
    }
  }
  const rendered = renderFields(fields, data);
  if (entries.length > 0 && Object.keys(rendered).length === 0) {
    warnings.push(`${label}：所有字段渲染后都为空，不会发送`);
  } else if (entries.length === 0) {
    warnings.push(`${label}：还没配置字段映射，不会发送`);
  }
  return Object.entries(rendered).map(([key, { value }]) => ({ key, value }));
}

/**
 * Collects placeholder problems across every channel, so `{{trackingNo}}`
 * used in four places is one warning naming the four places rather than four
 * warnings.
 *
 * Every text this shop renders is scanned: the in-app title and body, each
 * WeChat field, the 公众号 link. The SMS body is not — it is a note for the
 * operator, the provider holds the real text and its own `${name}` syntax.
 */
class PlaceholderAudit {
  private readonly unknown = new Map<string, string[]>();
  private readonly empty = new Map<string, string[]>();
  /** Keyed by the token as written, so `{order_id}` and `{$order_id}` are told apart. */
  private readonly legacy = new Map<string, { name: string; where: string[] }>();

  constructor(
    private readonly event: NotificationEvent,
    private readonly data: Readonly<Record<string, string>>,
  ) {}

  scan(where: string, template: string): void {
    for (const name of placeholdersIn(template)) {
      const bucket = !this.event.variables.includes(name)
        ? this.unknown
        : (this.data[name] ?? '') === ''
          ? this.empty
          : null;
      if (bucket) bucket.set(name, [...(bucket.get(name) ?? []), where]);
    }
    for (const { token, name } of legacyPlaceholdersIn(template)) {
      const entry = this.legacy.get(token) ?? { name, where: [] };
      if (!entry.where.includes(where)) entry.where.push(where);
      this.legacy.set(token, entry);
    }
  }

  /** `order_id` → `orderId`, when the event has that variable. */
  private replacementFor(name: string): string | undefined {
    const camel = name.replace(/_([a-z0-9])/g, (_match, next: string) => next.toUpperCase());
    return [name, camel].find((candidate) => this.event.variables.includes(candidate));
  }

  warnings(): string[] {
    return [
      ...[...this.legacy].map(([token, { name, where }]) => {
        const replacement = this.replacementFor(name);
        const fix = replacement
          ? `请改成 {{${replacement}}}`
          : '这个通知没有对应的变量，请删掉或改写';
        return `${token} 是旧系统的占位符写法，不会被替换，收到的人会原样看到（用在：${where.join('、')}）；${fix}`;
      }),
      ...[...this.unknown].map(
        ([name, where]) =>
          `{{${name}}} 不是这个通知的变量（用在：${where.join('、')}），发出去会是空的`,
      ),
      ...[...this.empty].map(
        ([name, where]) =>
          `示例数据里 {{${name}}} 为空（用在：${where.join('、')}），这一处会显示为空`,
      ),
    ];
  }
}

/**
 * WeChat's subscribe-message value rules, by the field's type prefix
 * (`thing3` → `thing`). A value that breaks one fails the whole message with
 * `47003`, which the send log records as a skip and nobody reads. Only the
 * rules that are about length or character class are checked; `time` and
 * `date` accept too many formats to be worth guessing at.
 */
export function subscribeFieldProblem(key: string, value: string): string | null {
  const type = key.replace(/\d+$/, '');
  const length = [...value].length;
  switch (type) {
    case 'thing':
      return length > 20 ? `超过 20 个字（现在 ${length} 个）` : null;
    case 'character_string':
      if (length > 32) return `超过 32 个字符（现在 ${length} 个）`;
      return /^[\x21-\x7e]*$/.test(value) ? null : '只能是字母、数字和符号，不能有汉字或空格';
    case 'number':
      return /^\d{1,32}(\.\d+)?$/.test(value) ? null : '只能是数字';
    case 'letter':
      return /^[A-Za-z]{1,32}$/.test(value) ? null : '只能是 32 个以内的字母';
    case 'amount':
      return /^[¥￥]?\d{1,10}(\.\d{1,2})?元?$/.test(value)
        ? null
        : '要是金额格式，如 199.00 或 ¥199.00';
    case 'phrase':
      return length > 5 ? `超过 5 个字（现在 ${length} 个）` : null;
    case 'name':
      return length > 10 ? `超过 10 个字（现在 ${length} 个）` : null;
    case 'phone_number':
      return /^[\d+\-() ]{1,17}$/.test(value) ? null : '要是 17 位以内的电话号码';
    case 'car_number':
      return length > 8 ? `超过 8 个字符（现在 ${length} 个）` : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// test send
// ---------------------------------------------------------------------------

/** A real message costs a real SMS; five a minute is plenty for checking wording. */
const TEST_SENDS_PER_MINUTE = 5;

export async function testSend(
  ctx: Ctx,
  params: { code: string },
  body: NotificationTestSendBody,
): Promise<NotificationTestSendResult> {
  requirePermission(ctx, notificationPermissions['template:write']);
  const event = requireEvent(params.code);
  if (event.audience !== 'user' || !event.channels.includes(body.channel)) {
    throw new DomainError('NOTIFICATION_CHANNEL_NOT_APPLICABLE');
  }

  await enforce(
    fixedWindow(ctx.redis, {
      key: `notification:test:${requireAdminId(ctx)}`,
      limit: TEST_SENDS_PER_MINUTE,
      windowMs: 60_000,
      nowMs: ctx.clock.now().getTime(),
    }),
  );

  // Testing before 启用 is the point, so the channel goes out whatever its switch says.
  const channels = {
    ...(body.channels as NotificationChannels),
    [body.channel]: { ...body.channels[body.channel], enabled: true },
  } as NotificationChannels;
  const input = { event, channels, userId: fromId(body.userId), data: { ...body.data } };
  const send = { wechatOa: sendWechatOa, wechatMini: sendWechatMini, sms: sendSms }[body.channel];

  let outcome: ChannelOutcome;
  let thrown: unknown;
  try {
    outcome = await send(ctx, input);
  } catch (error) {
    thrown = error;
    outcome = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
  // The raw reason (WeChat's errmsg, the SMS provider's text, a thrown error)
  // lives here only; `describeOutcome` tells the operator in Chinese.
  ctx.logger.info(
    { code: event.code, channel: body.channel, userId: body.userId, outcome, err: thrown },
    'notification test send',
  );
  return describeOutcome(body.channel, outcome);
}

const SENT: Record<NotificationTestSendBody['channel'], string> = {
  wechatOa: '已发送，请在微信里查收',
  wechatMini: '已发送，请在微信「服务通知」里查收',
  sms: '已提交给短信服务商，请留意手机',
};

/**
 * The 测试发送 result an operator reads. Only Chinese reaches `message`: a
 * known reason in their words (the tables in `notification.send.ts`, shared
 * with 发送记录), the gateway's code for whoever they ask for help, and never
 * WeChat's `errmsg`, the SMS provider's text, a thrown error's message or a
 * channel id. `testSend` logs the raw reason.
 */
export function describeOutcome(
  channel: NotificationTestSendBody['channel'],
  outcome: ChannelOutcome,
): NotificationTestSendResult {
  if (outcome.kind === 'sent') return { outcome: 'sent', message: SENT[channel] };
  const reason = outcome.reason;
  const lead = outcome.kind === 'skipped' ? '没有发出' : '发送失败';
  const known = explainChannelReason(reason);
  if (known !== null) return { outcome: outcome.kind, message: `${lead}：${known}` };
  const wechat = wechatCode(reason);
  if (wechat !== null) {
    return { outcome: outcome.kind, message: `${lead}：微信返回错误码 ${wechat}，${UNEXPLAINED}` };
  }
  const sms = smsCode(reason);
  if (sms !== null) {
    return { outcome: outcome.kind, message: `${lead}：短信服务商拒绝发送（${sms}）` };
  }
  return { outcome: outcome.kind, message: `${lead}，${UNEXPLAINED}` };
}

function requireEvent(code: string): NotificationEvent {
  const event = findNotificationEvent(code);
  if (!event) throw new DomainError('NOTIFICATION_TEMPLATE_NOT_FOUND');
  return event;
}
