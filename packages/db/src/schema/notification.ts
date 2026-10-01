import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import {
  createdAt,
  deletedAt,
  emptyJsonArray,
  emptyJsonObject,
  fk,
  instant,
  pk,
  updatedAt,
} from './_shared';
import { admins } from './auth';
import { users } from './user';

/**
 * Notification templates, in-app messages and the SMS log.
 *
 * A template is one row with one `channels` object rather than a column per
 * channel setting, so adding or removing a channel is a code change rather
 * than a migration. The channels are in-app, OA template message,
 * mini-program subscribe message and SMS.
 */

export const notificationTemplatesAudience = pgEnum('notification_templates_audience', [
  'user',
  'admin',
]);

/** Per-channel configuration. A channel absent from the object is not configured at all. */
export interface NotificationChannels {
  inApp?: { enabled: boolean; title: string; body: string };
  /** WeChat Official Account template message. */
  wechatOa?: {
    enabled: boolean;
    templateKey: string;
    templateId?: string;
    fields?: Record<string, string>;
    linkUrl?: string;
  };
  /**
   * Mini-program subscribe message. It opens its event's catalogue route; the
   * old hand-typed `page` was deleted by migration `0009`.
   */
  wechatMini?: {
    enabled: boolean;
    templateKey: string;
    templateId?: string;
    fields?: Record<string, string>;
  };
  sms?: {
    enabled: boolean;
    templateCode: string;
    signName?: string;
    /**
     * The template's variables in its own order: Tencent fills `{1}`, `{2}`…
     * from it positionally, Aliyun by `name`. Absent on rows saved before it
     * existed, which read as a template with no variables.
     */
    params?: { name: string; value: string }[];
    /** The template's wording, for the operator's reference; never sent. */
    body?: string;
  };
}

export const notificationTemplates = pgTable(
  'notification_templates',
  {
    id: pk(),
    /** Stable registry key the code sends by, e.g. `order_paid`. */
    code: varchar({ length: 64 }).notNull(),
    name: varchar({ length: 100 }).notNull(),
    /** When this fires, in prose, for the operator. */
    description: varchar({ length: 255 }),
    audience: notificationTemplatesAudience().notNull().default('user'),
    channels: jsonb().$type<NotificationChannels>().notNull().default(emptyJsonObject),
    /** Placeholder names the body may use, e.g. `["orderNo","amount"]`. */
    variables: jsonb().$type<string[]>().notNull().default(emptyJsonArray),
    isEnabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('notification_templates_code_uq').on(t.code),
    index('notification_templates_audience_idx').on(t.audience),
  ],
);

export type NotificationTemplate = typeof notificationTemplates.$inferSelect;
export type NewNotificationTemplate = typeof notificationTemplates.$inferInsert;

/**
 * In-app messages (站内信) for a customer or for the admin console, which also
 * feeds the SSE bell.
 */
export const notificationMessages = pgTable(
  'notification_messages',
  {
    id: pk(),
    /** The template that produced it, if any. Free-form broadcasts have none. */
    code: varchar({ length: 64 }),
    audience: notificationTemplatesAudience().notNull(),
    /** Set for `audience = 'user'`. */
    userId: fk().references(() => users.id, { onDelete: 'cascade' }),
    /** Set for `audience = 'admin'`. */
    adminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'cascade' }),
    title: varchar({ length: 255 }).notNull(),
    content: text().notNull(),
    /** Rendered variables plus anything the client needs to deep-link. */
    data: jsonb().$type<Record<string, unknown>>(),
    readAt: instant(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('notification_messages_user_idx')
      .on(t.userId, t.createdAt)
      .where(sql`audience = 'user'`),
    index('notification_messages_admin_idx')
      .on(t.adminId, t.createdAt)
      .where(sql`audience = 'admin'`),
    index('notification_messages_unread_idx')
      .on(t.userId)
      .where(sql`read_at is null and deleted_at is null`),
    check(
      'notification_messages_recipient',
      sql`(${t.audience} = 'user' and ${t.userId} is not null) or (${t.audience} = 'admin')`,
    ),
  ],
);

export type NotificationMessage = typeof notificationMessages.$inferSelect;
export type NewNotificationMessage = typeof notificationMessages.$inferInsert;

export const smsLogsStatus = pgEnum('sms_logs_status', ['sent', 'failed', 'unknown']);

/** One row per send attempt. Never holds the verification code itself. */
export const smsLogs = pgTable(
  'sms_logs',
  {
    id: pk(),
    phone: varchar({ length: 20 }).notNull(),
    /** Provider-side template code, e.g. `SMS_123456`. */
    templateCode: varchar({ length: 64 }).notNull(),
    /** The notification template this send belongs to, when it came from one. */
    notificationCode: varchar({ length: 64 }),
    /** Rendered parameters. Codes and other secrets are redacted before the row is written. */
    params: jsonb().$type<Record<string, string>>(),
    status: smsLogsStatus().notNull(),
    providerMessageId: varchar({ length: 64 }),
    errorCode: varchar({ length: 64 }),
    errorMessage: varchar({ length: 255 }),
    requestIp: varchar({ length: 45 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('sms_logs_phone_idx').on(t.phone, t.createdAt),
    index('sms_logs_created_at_idx').on(t.createdAt),
    index('sms_logs_status_idx').on(t.status),
  ],
);

export type SmsLog = typeof smsLogs.$inferSelect;
export type NewSmsLog = typeof smsLogs.$inferInsert;
