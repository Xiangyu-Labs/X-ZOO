import type { DashboardTile } from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import * as repo from './storage.repo';

/**
 * What the media library contributes to the admin home page.
 *
 * Exported as plain data rather than registered here on import, because
 * registering would mean importing `system/dashboard`, and a domain may only
 * reach another through its `index.ts` — while `system` already imports *this*
 * domain for its config group. One directed edge, `system → storage`, is enough
 * for both. `system/dashboard-tiles.ts` does the registration.
 *
 * The shape is written out rather than imported as `DashboardContributor` for
 * the same reason; the registration site checks it structurally.
 */
export const storageDashboardContributor: {
  key: string;
  permission: string;
  order: number;
  tiles(ctx: Ctx): Promise<DashboardTile[]>;
} = {
  key: 'storage',
  permission: 'storage:attachment:read',
  order: 400,
  async tiles(ctx) {
    const totals = await repo.attachmentTotals(ctx.db);
    return [
      {
        key: 'storage.files',
        label: '素材数量',
        value: totals.files,
        format: 'count',
        href: '/admin/storage/attachments',
        deltaFromYesterday: null,
      },
      {
        key: 'storage.bytes',
        label: '素材占用空间',
        value: totals.bytes,
        format: 'bytes',
        href: '/admin/storage/attachments',
        deltaFromYesterday: null,
      },
    ];
  },
};
