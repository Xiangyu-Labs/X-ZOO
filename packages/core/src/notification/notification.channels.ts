import type {
  NotificationChannel,
  NotificationChannelField,
  NotificationChannelProblem,
} from '@shop/contracts/notification/schemas';
import type { NotificationChannels } from './notification.repo';
import type { NotificationEvent } from './notification.registry';

/**
 * Whether a switched-on channel can actually send, in one place.
 *
 * The save refuses a channel that is on with nothing to send, but a row can
 * reach the table without passing the save — a direct database write, an import
 * from the old system — and the send then skips it with `no template id`,
 * a log line nobody reads, while the list shows the channel as on. So the list,
 * the form and the save all ask this module, and say the same thing.
 */

export const CHANNEL_LABELS: Readonly<Record<NotificationChannel, string>> = {
  inApp: '站内信',
  wechatOa: '公众号',
  wechatMini: '小程序',
  sms: '短信',
};

const FIELD_LABELS: Readonly<Record<NotificationChannelField, string>> = {
  title: '标题',
  body: '正文',
  templateCode: '短信模板编号',
  templateId: '模板 ID',
  fields: '字段映射',
};

/** What a channel needs before it can send, and does not have. Blank text counts as missing. */
export function missingFields(
  channel: NotificationChannel,
  config: NonNullable<NotificationChannels[NotificationChannel]>,
): NotificationChannelField[] {
  const missing: NotificationChannelField[] = [];
  if (channel === 'inApp') {
    const inApp = config as NonNullable<NotificationChannels['inApp']>;
    if (!inApp.title?.trim()) missing.push('title');
    if (!inApp.body?.trim()) missing.push('body');
  } else if (channel === 'sms') {
    const sms = config as NonNullable<NotificationChannels['sms']>;
    if (!sms.templateCode?.trim()) missing.push('templateCode');
  } else {
    const wechat = config as NonNullable<NotificationChannels['wechatOa']>;
    if (!wechat.templateId?.trim()) missing.push('templateId');
    if (Object.keys(wechat.fields ?? {}).length === 0) missing.push('fields');
  }
  return missing;
}

/**
 * Every channel that is switched on and cannot send: one the event does not
 * support at all, or one missing what it needs. A switched-off channel is
 * never a problem, however empty.
 */
export function channelProblems(
  event: Pick<NotificationEvent, 'channels'>,
  channels: NotificationChannels,
): NotificationChannelProblem[] {
  const problems: NotificationChannelProblem[] = [];
  for (const channel of Object.keys(CHANNEL_LABELS) as NotificationChannel[]) {
    const config = channels[channel];
    if (!config?.enabled) continue;
    if (!event.channels.includes(channel)) {
      problems.push({
        channel,
        kind: 'notApplicable',
        missing: [],
        message: '已开启但无法发送：该通知不支持此渠道',
      });
      continue;
    }
    const missing = missingFields(channel, config);
    if (missing.length > 0) {
      problems.push({
        channel,
        kind: 'incomplete',
        missing,
        message: `已开启但无法发送：缺${missing.map((field) => FIELD_LABELS[field]).join('、')}`,
      });
    }
  }
  return problems;
}

/**
 * Why a save was refused, naming each channel and the way out. The operator
 * may have come to change one word of the in-app text; without the channel's
 * name they cannot tell which of four switches is in the way.
 */
export function describeRefusal(problems: readonly NotificationChannelProblem[]): string {
  const named = problems
    .map((problem) => `「${CHANNEL_LABELS[problem.channel]}」${problem.message}`)
    .join('；');
  const these = problems.length > 1 ? '这些渠道' : '该渠道';
  return problems.every((problem) => problem.kind === 'notApplicable')
    ? `${named}。请关闭${these}后再保存`
    : `${named}。请填写，或关闭${these}后再保存`;
}
