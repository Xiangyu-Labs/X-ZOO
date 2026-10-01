import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * `agreement` — the three legal texts the storefront shows.
 *
 * Deliberately a config group rather than a fourth CRUD screen with its own
 * table. There are exactly three of them, they are edited once a year, and the
 * only thing a table would add is a schema, a repo, four routes and a page —
 * for a feature whose entire behaviour is "store this HTML and hand it back".
 *
 * The storefront reads them through `GET /api/v1/agreements/:key`, which is
 * public and does not mention config groups; if these ever need versioning or
 * an acceptance record per user, that is when they earn a table.
 */
export const agreementConfig = defineConfigGroup({
  group: 'agreement',
  title: '协议与条款',
  description: '用户协议、隐私政策、注销协议的标题与正文。',
  category: 'basic',
  permission: 'system:config:read',
  schema: z.object({
    userTitle: z.string().max(64).default('用户服务协议'),
    user: z.string().max(200_000).default(''),
    privacyTitle: z.string().max(64).default('隐私政策'),
    privacy: z.string().max(200_000).default(''),
    cancellationTitle: z.string().max(64).default('注销协议'),
    cancellation: z.string().max(200_000).default(''),
  }),
  ui: {
    userTitle: { label: '用户协议标题', type: 'text', section: '用户协议', order: 1 },
    user: { label: '用户协议内容', type: 'textarea', section: '用户协议', order: 2 },
    privacyTitle: { label: '隐私政策标题', type: 'text', section: '隐私政策', order: 3 },
    privacy: { label: '隐私政策内容', type: 'textarea', section: '隐私政策', order: 4 },
    cancellationTitle: { label: '注销协议标题', type: 'text', section: '注销协议', order: 5 },
    cancellation: { label: '注销协议内容', type: 'textarea', section: '注销协议', order: 6 },
  },
});

/** The wire key -> the two config keys that hold it. */
export const AGREEMENT_FIELDS = {
  user: { title: 'userTitle', content: 'user' },
  privacy: { title: 'privacyTitle', content: 'privacy' },
  cancellation: { title: 'cancellationTitle', content: 'cancellation' },
} as const;
