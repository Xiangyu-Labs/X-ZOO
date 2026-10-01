import type { AssetItem, AssetListResult, AssetSource } from '@/admin/kit/asset/types';

/**
 * The kit demo's `AssetSource`: a dozen in-memory images, like the rest of
 * this page's data. `<AssetPicker>` has no fallback source, and the demo must
 * not upload into or delete from the shop's real library, so it mounts this
 * one over the shell's.
 */

function placeholder(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="hsl(${hue} 60% 80%)"/><text x="50%" y="52%" font-family="sans-serif" font-size="22" fill="hsl(${hue} 70% 25%)" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function createDemoAssetSource(): AssetSource {
  let nextId = 13;
  const items: AssetItem[] = Array.from({ length: 12 }, (_unused, index) => ({
    id: String(index + 1),
    url: placeholder(`图 ${index + 1}`, (index * 37) % 360),
    name: `示例素材-${index + 1}.png`,
    mime: 'image/png',
    size: 12_000 + index * 137,
  }));
  const categoryOf = new Map(items.map((item, index) => [item.id, index % 2 ? '2' : '1']));

  return {
    async listCategories() {
      return [
        { id: '1', name: '商品图' },
        { id: '2', name: '装修素材' },
      ];
    },

    async listAssets(query): Promise<AssetListResult> {
      const keyword = query.keyword?.trim().toLowerCase();
      const filtered = items.filter(
        (item) =>
          (!query.categoryId || categoryOf.get(item.id) === query.categoryId) &&
          (!keyword || item.name.toLowerCase().includes(keyword)),
      );
      const start = (query.page - 1) * query.pageSize;
      return {
        items: filtered.slice(start, start + query.pageSize),
        total: filtered.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    async upload(file, categoryId) {
      const item: AssetItem = {
        id: String(nextId++),
        url: placeholder(file.name.slice(0, 8) || '新图', (nextId * 53) % 360),
        name: file.name,
        mime: file.type || 'image/png',
        size: file.size,
      };
      items.unshift(item);
      categoryOf.set(item.id, categoryId ?? '1');
      return item;
    },

    async remove(ids) {
      for (const id of ids) {
        const index = items.findIndex((item) => item.id === id);
        if (index >= 0) items.splice(index, 1);
        categoryOf.delete(id);
      }
    },
  };
}
