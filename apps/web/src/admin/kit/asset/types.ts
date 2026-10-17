import type { z } from 'zod';

import type { asset } from '../../api/contracts';

/** Exactly the frozen `asset` shape from the contracts conventions. */
export type AssetItem = z.infer<typeof asset>;

export interface AssetCategory {
  id: string;
  name: string;
  children?: AssetCategory[] | undefined;
}

export interface AssetListQuery {
  /** `undefined` means "all categories". */
  categoryId?: string | undefined;
  page: number;
  pageSize: number;
  keyword?: string | undefined;
  /** What the field takes: pictures (the default) or videos. */
  kind?: AssetKind | undefined;
}

export type AssetKind = 'image' | 'video';

/** The kind a picker's `accept` asks for: `video/*`, `video/mp4` → videos; anything else pictures. */
export function assetKindOf(accept: string | undefined): AssetKind {
  return accept !== undefined && accept.trim().startsWith('video/') ? 'video' : 'image';
}

export interface AssetListResult {
  items: AssetItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Everything `<AssetPicker>` needs from the material library.
 *
 * The kit ships the UI only. The `storage` domain implements this interface
 * on top of the real `/admin-api/attachments` routes and installs it with
 * `<AssetSourceProvider source={…}>` in the shell layout; tests install
 * `createStubAssetSource()` from `@/test/asset-source`.
 */
export interface AssetSource {
  /**
   * The atoms each call needs, when the source is backed by permissioned
   * routes. The picker leaves out what the signed-in admin may not do rather
   * than letting it end in a 403 toast. Absent means "no check".
   */
  permissions?:
    | {
        list?: string | undefined;
        upload?: string | undefined;
        categories?: string | undefined;
        /** 新建分类 in the picker. */
        createCategory?: string | undefined;
        /** No picker control deletes today; one that does checks this first. */
        remove?: string | undefined;
      }
    | undefined;
  listCategories(): Promise<AssetCategory[]>;
  /**
   * Files a new folder (`parentId` absent means top level) and resolves with
   * it. Optional: a source without it shows no 新建分类.
   */
  createCategory?:
    | ((input: { name: string; parentId?: string | undefined }) => Promise<AssetCategory>)
    | undefined;
  listAssets(query: AssetListQuery): Promise<AssetListResult>;
  /** Resolves with the stored asset. Throw to surface an upload failure. */
  upload(file: File, categoryId?: string | undefined): Promise<AssetItem>;
  remove(ids: string[]): Promise<void>;
}
