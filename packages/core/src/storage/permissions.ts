import { definePermissions } from '../auth/permissions';

/**
 * Media-library atoms.
 *
 * Deleting is not the same act as uploading — a content editor needs `write`,
 * only a manager needs `delete` — so one `上传图片` checkbox covering the
 * library, the folders and the delete button would be too coarse. They are
 * separate atoms, and the folder tree is separate again.
 *
 * There is deliberately **no atom for the storefront upload endpoint**: a
 * shopper is not an admin and holds no atoms. That endpoint is guarded by
 * `auth: 'user'`, a purpose whitelist and a per-user rate limit instead.
 *
 * These names are what `packages/contracts/src/storage/*.contract.ts` already
 * declares; the two must agree or `handle()` refuses the route at boot.
 */
export const storagePermissions = definePermissions(
  'storage',
  {
    'attachment:read': '查看素材库',
    'attachment:write': '上传与编辑素材',
    'attachment:delete': '删除素材',
    'category:read': '查看素材分类',
    'category:write': '新建与编辑素材分类',
    'category:delete': '删除素材分类',
  },
  { section: '素材' },
);
