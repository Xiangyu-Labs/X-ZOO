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
        /** No picker control deletes today; one that does checks this first. */
        remove?: string | undefined;
      }
    | undefined;
  listCategories(): Promise<AssetCategory[]>;
  listAssets(query: AssetListQuery): Promise<AssetListResult>;
  /** Resolves with the stored asset. Throw to surface an upload failure. */
  upload(file: File, categoryId?: string | undefined): Promise<AssetItem>;
  remove(ids: string[]): Promise<void>;
}
