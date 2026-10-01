import { definePermissions } from '../auth/permissions';

/**
 * Shipping permission atoms.
 *
 * Four, split the way the two jobs actually divide:
 *
 *  - whoever prices delivery edits 运费模板 (`template:read` / `template:write`
 *    / `template:delete`). Deleting is its own atom because a template that
 *    disappears silently re-prices every product pointing at it;
 *  - whoever maintains the carrier list edits 快递公司 (`express:read` /
 *    `express:write`).
 *
 * What is deliberately **not** here: the 快递公司 *picker* on the 发货 form.
 * That route keeps `order:order:read`, so an operator trusted to dispatch goods
 * needs no second grant to see the list of couriers. Only the management screen
 * costs `shipping:express:*`.
 *
 * The city tree has no atom of its own either — it is immutable seed data that
 * the template editor needs, so it rides on `shipping:template:read`.
 */
export const shippingPermissions = definePermissions(
  'shipping',
  {
    'template:read': '查看运费模板',
    'template:write': '新建/编辑运费模板',
    'template:delete': '删除运费模板',
    'express:read': '查看快递公司',
    'express:write': '维护快递公司',
  },
  { section: '物流' },
);
