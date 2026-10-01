import { paymentEffectScopes } from '@shop/contracts/payment/schemas';
import { hasPermission } from '../auth/rbac';
import { countParkedEffects } from '../effects';
import type { Ctx } from '../kernel/context';
import { countUnresolvedFailedJobs } from '../kernel/failed-jobs.repo';
import { storageDashboardContributor } from '../storage/index';
import { countTile, registerDashboardContributor } from './dashboard';
import * as repo from './system.repo';

/**
 * The tiles `system` contributes, and the registration bucket for `system` and
 * `storage`.
 *
 * Registration is a side effect of import, exactly like config groups, so
 * `system/index.ts` imports this file and nothing else has to know. Any other
 * domain registers its own from its own `index.ts`, importing
 * `registerDashboardContributor` from `@shop/core/system`.
 *
 * `storage`'s contributor is registered from here rather than from its own
 * module so the dependency stays one-way: `system` already imports `storage`
 * for its config group, and a second edge back would be a cycle.
 */

registerDashboardContributor({
  key: 'system',
  permission: 'system:admin:read',
  order: 900,
  async tiles(ctx) {
    const admins = await repo.countAdmins(ctx.db);
    return [
      countTile({
        key: 'system.admins',
        label: '管理员',
        value: admins,
        href: '/admin/system/admins',
      }),
    ];
  },
});

registerDashboardContributor(storageDashboardContributor);

/**
 * One kind of work that stopped and waits for a person: what it is called, the
 * screen that lists it, the atom that screen needs, and how many there are.
 */
export interface AttentionSource {
  key: string;
  /** The screen's menu label, so the link reads like the menu it leads to. */
  label: string;
  href: string;
  atom: string;
  /** Lower first, both in the tile's links and for which one `href` picks. */
  order: number;
  count(ctx: Ctx): Promise<number>;
}

const attentionSources = new Map<string, AttentionSource>();

/**
 * Adds a source to 「异常待处理」. A domain registers its own from its
 * `register…Domain()`, the way `payment` adds 异常支付: `system` is imported by
 * every domain and cannot import them back.
 */
export function registerAttentionSource(source: AttentionSource): void {
  attentionSources.set(source.key, source);
}

registerAttentionSource({
  key: 'effects',
  label: '待处理任务',
  href: '/admin/trade/effects',
  atom: 'payment:effect:handle',
  order: 20,
  // In the scopes the 待处理任务 console shows (`paymentEffectScopes` — refunds
  // that never left, WeChat 发货信息 never recorded, groupbuys never settled…).
  count: (ctx) => countParkedEffects(ctx, paymentEffectScopes),
});

registerAttentionSource({
  key: 'failedJobs',
  label: '失败的后台任务',
  href: '/admin/system/failed-jobs',
  atom: 'system:job:handle',
  order: 30,
  count: (ctx) => countUnresolvedFailedJobs(ctx.db),
});

/**
 * 「异常待处理」: work that stopped and waits for a person (AGENTS.md rule 9).
 *
 * The registered sources — effects parked after their retries ran out, background
 * jobs that failed every retry, money 异常支付 holds — each counted only for an
 * admin who may open its screen. The tile links to the first screen with work in
 * it and lists every source as its own link. One `count(*)` per source, on
 * indexed or tiny sets; nothing for an admin who may open none of them.
 */
export async function attentionTiles(ctx: Ctx) {
  const visible = [...attentionSources.values()]
    .filter((source) => hasPermission(ctx.actor, source.atom))
    .sort((a, b) => a.order - b.order);
  if (visible.length === 0) return [];
  const counts = await Promise.all(visible.map((source) => source.count(ctx)));
  const parts = visible.map((source, index) => ({
    key: source.key,
    label: source.label,
    value: counts[index] ?? 0,
    href: source.href,
  }));
  const href = (parts.find((part) => part.value > 0) ?? parts[0]!).href;
  const value = parts.reduce((sum, part) => sum + part.value, 0);
  return [
    {
      ...countTile({ key: 'system.attention', label: '异常待处理', value, href }),
      attention: true,
      parts,
    },
  ];
}

registerDashboardContributor({
  key: 'attention',
  // First on the page: it is the one figure that asks somebody to act.
  order: 0,
  tiles: attentionTiles,
});
