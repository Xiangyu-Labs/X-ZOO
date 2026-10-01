import type { ReactElement } from 'react';

import { AssetSourceProvider } from '@/admin/kit/asset/asset-source-context';
import type {
  AssetCategory,
  AssetItem,
  AssetListQuery,
  AssetListResult,
  AssetSource,
} from '@/admin/kit/asset/types';

function placeholder(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="hsl(${hue} 60% 80%)"/><text x="50%" y="52%" font-family="sans-serif" font-size="22" fill="hsl(${hue} 70% 25%)" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const CATEGORIES: AssetCategory[] = [
  {
    id: '1',
    name: '商品图',
    children: [
      { id: '11', name: '主图' },
      { id: '12', name: '详情图' },
    ],
  },
  { id: '2', name: '装修素材' },
  { id: '3', name: '未分类' },
];

/**
 * An in-memory `AssetSource`, for tests only.
 *
 * It behaves like the real library (pagination, category and keyword filters,
 * upload, delete), so a test drives `<AssetPicker>` without the storage
 * routes: wrap the subject in `<AssetSourceProvider
 * source={createStubAssetSource()}>`. The admin shell mounts the real source
 * (`StorageAssetSourceProvider`), and `useAssetSource()` throws when no
 * provider is mounted, so these files can never reach a saved record.
 */
export function createStubAssetSource(seed = 24): AssetSource {
  let nextId = seed + 1;
  const items: AssetItem[] = Array.from({ length: seed }, (_, index) => ({
    id: String(index + 1),
    url: placeholder(`图 ${index + 1}`, (index * 37) % 360),
    name: `示例素材-${index + 1}.png`,
    mime: 'image/png',
    size: 12_000 + index * 137,
  }));
  const categoryOf = new Map<string, string>(
    items.map((item, index) => [item.id, ['11', '12', '2', '3'][index % 4] ?? '3']),
  );

  return {
    async listCategories() {
      return structuredClone(CATEGORIES);
    },

    async listAssets(query: AssetListQuery): Promise<AssetListResult> {
      const keyword = query.keyword?.trim().toLowerCase();
      const filtered = items.filter((item) => {
        if (query.categoryId && categoryOf.get(item.id) !== query.categoryId) return false;
        if (keyword && !item.name.toLowerCase().includes(keyword)) return false;
        return true;
      });
      const start = (query.page - 1) * query.pageSize;
      return {
        items: filtered.slice(start, start + query.pageSize),
        total: filtered.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    async upload(file: File, categoryId?: string) {
      const item: AssetItem = {
        id: String(nextId++),
        url: placeholder(file.name.slice(0, 8) || '新图', (nextId * 53) % 360),
        name: file.name,
        mime: file.type || 'image/png',
        size: file.size,
      };
      items.unshift(item);
      categoryOf.set(item.id, categoryId ?? '3');
      return item;
    },

    async remove(ids: string[]) {
      for (const id of ids) {
        const index = items.findIndex((item) => item.id === id);
        if (index >= 0) items.splice(index, 1);
        categoryOf.delete(id);
      }
    },
  };
}

/**
 * `ui` under a fresh stub library: what the admin shell gives every page, for
 * a test that renders a page or form carrying an asset field without opening
 * the picker.
 */
export function withStubAssets(ui: ReactElement, source = createStubAssetSource()): ReactElement {
  return <AssetSourceProvider source={source}>{ui}</AssetSourceProvider>;
}
