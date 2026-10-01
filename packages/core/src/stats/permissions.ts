import { definePermissions } from '../auth/permissions';

/**
 * Statistics permission atoms.
 *
 * One `read` per screen, because the four screens answer to different people —
 * whoever watches traffic is rarely whoever watches revenue — and two
 * `export` atoms on top of the reads.
 *
 * **Export is its own atom, deliberately.** Reading 交易统计 on screen and
 * walking out with the whole window as a CSV are different acts: the file
 * leaves the building and the audit trail behind it is one row saying somebody
 * exported. With a single 统计 permission covering both, every operator who
 * could open the page could take the file.
 *
 * There is no `stats:*:write`: nothing in this domain writes anything.
 */
export const statsPermissions = definePermissions(
  'stats',
  {
    'user:read': '查看用户统计',
    'product:read': '查看商品统计',
    'trade:read': '查看交易统计',
    'order:read': '查看订单统计',
    'sales:read': '查看销售看板',
    'product:export': '导出商品统计',
    'trade:export': '导出交易统计',
    'sales:export': '导出销售看板',
  },
  { section: '统计' },
);
