import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * `notification` — how the shop's own notifications behave.
 *
 * The credentials are *not* here: the OA and mini-program apps live in the
 * `wechat-oa` / `wechat-mini` groups and in the `wechat` group, and the SMS
 * provider in `sms`. Group names are global, so this domain declares one group
 * and reads the other four.
 *
 * The shop's public origin is **not** here either: it is the `site` group's
 * `publicOrigin` / `extraOrigins`, read through `publicOrigin(ctx)` and
 * `isTrustedHost(ctx, …)` from `@shop/core/system`. 站点公开地址 under 通知设置
 * is not where an operator looks for it, and the JS-SDK signer would have to
 * import this domain to ask a question that has nothing to do with
 * notifications.
 */
export const notificationConfig = defineConfigGroup({
  group: 'notification',
  title: '通知设置',
  description: '订阅消息跳转的小程序版本与站内信保留天数。',
  category: 'integration',
  permission: 'system:config:read',
  schema: z.object({
    /**
     * `mini_program_state` for subscribe messages. `formal` in production;
     * `trial`/`developer` exist because a shop testing a new template
     * otherwise has to choose between not testing and messaging customers.
     */
    miniProgramState: z.enum(['developer', 'trial', 'formal']).default('formal'),
    /** In-app messages older than this are pruned by the nightly job. 0 keeps them forever. */
    retentionDays: z.number().int().min(0).max(3650).default(180),
  }),
  ui: {
    miniProgramState: {
      label: '小程序版本',
      type: 'select',
      options: [
        { label: '正式版', value: 'formal' },
        { label: '体验版', value: 'trial' },
        { label: '开发版', value: 'developer' },
      ],
      order: 3,
    },
    retentionDays: {
      label: '站内信保留天数',
      type: 'number',
      unit: 'days',
      help: '0 表示永久保留',
      order: 4,
    },
  },
});

export type NotificationConfig = z.infer<typeof notificationConfig.schema>;
