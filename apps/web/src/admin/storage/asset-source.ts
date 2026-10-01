import {
  storageAttachmentDeleteMany,
  storageAttachmentList,
  storageAttachmentUpload,
  storageCategoryTree,
} from '@shop/contracts/storage/storage.admin.contract';
import type { AttachmentCategoryNode, AttachmentItem } from '@shop/contracts/storage/schemas';

import { callRoute } from '../api/call-route';
import type { AssetCategory, AssetListResult, AssetSource } from '../kit/asset/types';
import { uploadFile } from './upload';

/**
 * The real material library behind `<AssetPicker>`.
 *
 * The kit programs against `AssetSource`, not against routes, so this is the
 * only file that knows the picker and the storage routes exist in the same
 * application. Nothing in the kit changes.
 *
 * Note what is *not* here: no key, path or URL is ever sent to the server. The
 * upload route takes bytes and an optional category, and the server decides
 * where they land — that was the `videoDataSave` defect, where the client chose
 * the path.
 */
export function createStorageAssetSource(): AssetSource {
  return {
    // Read off the routes, so a contract that changes its atom changes this.
    permissions: {
      list: storageAttachmentList.permission,
      upload: storageAttachmentUpload.permission,
      categories: storageCategoryTree.permission,
      remove: storageAttachmentDeleteMany.permission,
    },

    async listCategories(): Promise<AssetCategory[]> {
      const { items } = await callRoute(storageCategoryTree);
      return nestCategories(items);
    },

    async listAssets(query): Promise<AssetListResult> {
      const page = await callRoute(storageAttachmentList, {
        query: {
          page: query.page,
          pageSize: query.pageSize,
          ...(query.categoryId ? { categoryId: query.categoryId } : {}),
          ...(query.keyword ? { keyword: query.keyword } : {}),
          // The picker's folders are browsing aids, not filters: opening 商品图
          // should show what is filed underneath it too.
          includeSubcategories: query.categoryId ? 'true' : 'false',
          kind: 'image',
          sortBy: 'createdAt',
          sortOrder: 'desc',
        },
      });
      return {
        items: page.items.map(toAssetItem),
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
      };
    },

    async upload(file, categoryId) {
      const result = await uploadFile(
        storageAttachmentUpload,
        { query: categoryId ? { categoryId } : {} },
        file,
      );
      return toAssetItem(result.attachment);
    },

    async remove(ids) {
      if (ids.length === 0) return;
      await callRoute(storageAttachmentDeleteMany, { body: { ids } });
    },
  };
}

/** The contract's attachment row narrowed to the frozen `asset` shape. */
function toAssetItem(item: AttachmentItem) {
  return {
    id: item.id,
    url: item.url,
    name: item.name,
    mime: item.mime,
    size: item.size,
  };
}

/**
 * The tree arrives flat in depth-first display order (a self-referential zod
 * schema blows the stack in `zod-to-openapi`), so the client nests it. One pass:
 * every parent is declared before its children.
 */
export function nestCategories(items: readonly AttachmentCategoryNode[]): AssetCategory[] {
  const byId = new Map<string, AssetCategory & { children: AssetCategory[] }>();
  const roots: AssetCategory[] = [];

  for (const node of items) {
    const entry = { id: node.id, name: node.name, children: [] as AssetCategory[] };
    byId.set(node.id, entry);
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }

  return roots;
}
