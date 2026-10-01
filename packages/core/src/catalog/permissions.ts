import { definePermissions } from '../auth/permissions';

/**
 * Catalog permission atoms.
 *
 * One atom per *job somebody actually does*, not one per route. Seventeen for
 * sixty-five routes, and the splits all earn their keep:
 *
 *  - `product:delete` is separate from `product:write` because it moves a
 *    product to the recycle bin and back, which is a supervisor's job, not an
 *    editor's.
 *  - `product:export` is separate because the export carries **cost prices**.
 *    A merchandiser who may edit a product should not automatically be able to
 *    download the shop's margins.
 *  - `card:read` is separate from every other read because the rows are
 *    redeemable secrets. Seeing a card number is not seeing a product.
 *  - **`protection:*` exists at all** because folding the 商品保障 routes into
 *    商品参数 would mean a role granted "product parameters" silently also
 *    granted "edit the guarantee badges shown on every product page".
 *
 * The atom string is `catalog:<resource>:<action>`; `definePermissions` adds the
 * domain prefix, so the keys here omit it.
 */
export const catalogPermissions = definePermissions(
  'catalog',
  {
    'category:read': '查看商品分类',
    'category:write': '新建/编辑/删除商品分类',

    'product:read': '查看商品',
    'product:write': '新建/编辑商品，上下架',
    'product:delete': '删除商品与回收站',
    'product:export': '导出商品（含成本价）',

    'card:read': '查看卡密库存',
    'card:write': '导入/作废卡密',

    'label:read': '查看商品标签',
    'label:write': '新建/编辑/删除商品标签',

    'param:read': '查看商品参数',
    'param:write': '新建/编辑/删除商品参数',

    'protection:read': '查看商品保障服务',
    'protection:write': '新建/编辑/删除商品保障服务',

    'review:read': '查看商品评价',
    'review:write': '回复/审核/添加商品评价',
    'review:delete': '删除商品评价',
  },
  { section: '商品' },
);
