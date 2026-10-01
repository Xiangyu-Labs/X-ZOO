import { z } from 'zod';
import { defineConfigGroup } from '../kernel/config-registry';

/**
 * 拼团设置.
 *
 * There is no 虚拟成团 switch any more (decided 2026-09-23). The mini-program
 * is the only storefront after the cutover, and a team completed with invented
 * members reads as a fake transaction there (WeChat 运营规范 3.2.5), so a team
 * that does not fill by its deadline fails and every paid member is refunded.
 * The old `virtualFillOnExpiry` key is not in the schema, so a stored value is
 * dropped on read; migration `0005_groupbuy_virtual_fill_off` deletes it too,
 * which keeps it off if an upgrade rolls back to an image that still reads it.
 *
 * The group declares the *read* atom, as every config group does; the settings
 * service derives the write gate from it (`writePermissionFor`), so seeing this
 * form needs `groupbuy:activity:read` and saving it needs
 * `groupbuy:activity:write`. "May we fake teams" is not a setting a 运营
 * assistant should be able to flip.
 */
export const groupbuyConfig = defineConfigGroup({
  group: 'groupbuy',
  title: '拼团设置',
  description: '过期拼团清理与拼团频道头图。',
  category: 'trade',
  permission: 'groupbuy:activity:read',
  schema: z.object({
    /** Groups one sweep pass handles. The per-group delayed job does the real work. */
    groupExpirySweepLimit: z.number().int().min(1).max(2_000).default(200),
    /**
     * The 拼团频道 head images. Config rather than a table because there are
     * two of them; a DIY page that wants richer banners uses the DIY components
     * instead.
     */
    banners: z
      .array(z.object({ imageUrl: z.string().max(512), link: z.string().max(255).nullable() }))
      .max(10)
      .default([]),
  }),
  ui: {
    groupExpirySweepLimit: {
      label: '过期拼团每次清理数量',
      type: 'number',
      help: '兜底扫描每次处理的拼团数，正常情况下由单个延时任务先行结算。到期未满员的拼团一律失败并自动退款（不支持虚拟成团）',
      section: '成团',
    },
    banners: {
      label: '拼团频道头图',
      type: 'json',
      help: '形如 [{"imageUrl":"https://…","link":null}]，link 为空表示不跳转',
      section: '分享',
    },
  },
});

export type GroupbuyConfig = z.infer<typeof groupbuyConfig.schema>;
