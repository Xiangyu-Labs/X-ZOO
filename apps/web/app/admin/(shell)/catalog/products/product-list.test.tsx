import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogAdminCategoryTree } from '@shop/contracts/catalog/catalog.category.admin.contract';
import {
  catalogAdminProductDelete,
  catalogAdminProductExport,
  catalogAdminProductList,
  catalogAdminProductRestore,
  catalogAdminProductSetStatus,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import {
  adminProductDetailExample,
  type AdminProductDetail,
  type AdminProductListItem,
  type ProductExportResult,
} from '@shop/contracts/catalog/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { ProductListPage } from './product-list';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/catalog/products',
  useSearchParams: () => search,
}));

/**
 * The product list as a component test: no browser, no server, one stub
 * `fetch`.
 *
 * What is worth asserting on a kit-built page is the *wiring* — that the table
 * asks the right route with the right tab, that permissions really hide the
 * write actions, and that an action sends the body the contract declares. The
 * kit's own tests cover paging, sorting and filter rendering.
 */

const row: AdminProductListItem = {
  id: '1',
  name: '简约白 T 恤',
  subtitle: '100% 纯棉',
  spu: 'TS-001',
  kind: 'physical',
  status: 'on_shelf',
  imageUrl: 'https://cdn.example.com/t.png',
  price: '39.00',
  originalPrice: '59.00',
  cost: '12.00',
  stock: 0,
  sales: 120,
  displaySalesBoost: 500,
  views: 3400,
  specMode: true,
  isHot: true,
  isNew: false,
  isBest: false,
  isBenefit: false,
  isRecommended: true,
  sortOrder: 0,
  categoryIds: ['17'],
  categoryNames: ['男装'],
  labels: [],
  createdAt: '2026-06-01T10:00:00+08:00',
  updatedAt: '2026-06-01T10:00:00+08:00',
  deletedAt: null,
};

const exportPayload: ProductExportResult = {
  filename: '商品列表.csv',
  columns: [
    { key: 'id', title: 'ID' },
    { key: 'name', title: '商品名称' },
  ],
  rows: [
    { id: '1', name: '简约白 T 恤' },
    { id: '2', name: '=HYPERLINK("https://evil.example","点我")' },
  ],
  total: 2,
  truncated: false,
};

function stubApi(): StubCall[] {
  // The status and restore routes answer with the whole product, not a row.
  const detail: AdminProductDetail = { ...adminProductDetailExample, ...row };
  return stubRoutes([
    on(catalogAdminCategoryTree, { items: [] }),
    on(catalogAdminProductExport, exportPayload),
    on(catalogAdminProductList, { items: [row], total: 1, page: 1, pageSize: 20 }),
    on(catalogAdminProductSetStatus, { ...detail, status: 'off_shelf' }),
    on(catalogAdminProductRestore, detail),
    on(catalogAdminProductDelete, undefined),
  ]);
}

afterEach(() => {
  resetApiConfig();
  search = new URLSearchParams();
});

const allPermissions = {
  ...testIdentity,
  permissions: [
    'catalog:product:read',
    'catalog:product:write',
    'catalog:product:delete',
    'catalog:product:export',
  ],
};

describe('商品列表', () => {
  it('lists products through the contract route, on the 全部 tab', async () => {
    const calls = stubApi();
    renderAdmin(<ProductListPage />, { identity: allPermissions });

    expect(await screen.findByText('简约白 T 恤')).toBeInTheDocument();
    // One `kind`, not an `is_virtual` flag plus a `virtual_type`.
    expect(screen.getByText('实物商品')).toBeInTheDocument();
    expect(screen.getByText('#男装')).toBeInTheDocument();
    const list = calls.find((call) => call.url.includes('/admin-api/catalog/products'));
    expect(list?.url).toContain('tab=all');
    expect(list?.url).toContain('page=1');
  });

  it('编辑 opens the editor with this tab and filters, so its 返回列表 comes back here', async () => {
    search = new URLSearchParams('tab=on_shelf&keyword=T恤');
    stubApi();
    renderAdmin(<ProductListPage />, { identity: allPermissions });
    await screen.findByText('简约白 T 恤');

    const edit = screen.getByRole('button', { name: zhName('编辑') }).closest('a');
    const href = new URL(edit!.getAttribute('href')!, 'https://shop.example');
    expect(href.pathname).toBe('/admin/catalog/products/1');
    expect(new URLSearchParams(href.searchParams.get('list')!).get('keyword')).toBe('T恤');
    expect(new URLSearchParams(href.searchParams.get('list')!).get('tab')).toBe('on_shelf');
  });

  it('separates the real sales count from the number the storefront shows', async () => {
    stubApi();
    renderAdmin(<ProductListPage />, { identity: allPermissions });
    await screen.findByText('简约白 T 恤');

    // 120 real, +500 boost — two numbers, never one conflated total.
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('+500')).toBeInTheDocument();
  });

  it('hides every write action from a read-only admin', async () => {
    stubApi();
    renderAdmin(<ProductListPage />, {
      identity: { ...testIdentity, permissions: ['catalog:product:read'] },
    });

    await screen.findByText('简约白 T 恤');
    expect(screen.queryByRole('button', { name: zhName('新建商品') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('下架') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('删除') })).not.toBeInTheDocument();
    // The export carries cost prices and has its own atom.
    expect(screen.queryByRole('button', { name: zhName('导出') })).not.toBeInTheDocument();
  });

  it('offers the 分类 filter only to a role that may read categories, instead of a 403', async () => {
    const calls = stubApi();
    const { unmount } = renderAdmin(<ProductListPage />, { identity: allPermissions });
    await screen.findByText('简约白 T 恤');
    expect(calls.some((call) => call.url.includes('/admin-api/catalog/categories'))).toBe(false);
    expect(screen.queryByText('全部分类')).toBeNull();
    unmount();

    renderAdmin(<ProductListPage />, {
      identity: {
        ...allPermissions,
        permissions: [...allPermissions.permissions, 'catalog:category:read'],
      },
    });
    expect(await screen.findByText('全部分类')).toBeInTheDocument();
  });

  it('takes a product off the shelf through the status sub-resource, after asking by name', async () => {
    const calls = stubApi();
    renderAdmin(<ProductListPage />, { identity: allPermissions });
    await screen.findByText('简约白 T 恤');

    await userEvent.click(screen.getByRole('button', { name: zhName('下架') }));
    const ask = await screen.findByText('下架「简约白 T 恤」？');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    const popup = ask.closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('下架') }));

    await waitFor(() => {
      const toggle = calls.find((call) => call.method === 'POST');
      expect(toggle?.url).toContain('/admin-api/catalog/products/1/status');
      expect(toggle?.body).toEqual({ status: 'off_shelf' });
    });
  });

  it('names the product when asking to move it to 回收站', async () => {
    stubApi();
    renderAdmin(<ProductListPage />, { identity: allPermissions });
    await screen.findByText('简约白 T 恤');

    await userEvent.click(screen.getByRole('button', { name: zhName('删除') }));
    expect(await screen.findByText('将「简约白 T 恤」移入回收站？')).toBeInTheDocument();
  });

  it('switching to 回收站 re-asks with that tab and offers 恢复 instead of 删除', async () => {
    const calls = stubApi();
    renderAdmin(<ProductListPage />, { identity: allPermissions });
    await screen.findByText('简约白 T 恤');

    await userEvent.click(screen.getByRole('tab', { name: zhName('回收站') }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('tab=deleted'))).toBe(true);
    });
    expect(await screen.findByRole('button', { name: zhName('恢复') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('下架') })).not.toBeInTheDocument();
  });

  it('exports the current tab as a CSV the browser writes', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:stub';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });

    const calls = stubApi();
    renderAdmin(<ProductListPage />, { identity: allPermissions });
    await screen.findByText('简约白 T 恤');

    await userEvent.click(screen.getByRole('button', { name: zhName('导出') }));

    await waitFor(() => {
      const exportCall = calls.find((call) => call.url.includes('/product-export'));
      expect(exportCall?.url).toContain('tab=all');
      expect(exportCall?.url).toContain('limit=2000');
    });
    // The rows arrive as JSON and become a file here, not on the server.
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(click).toHaveBeenCalled();
    expect(saved).toEqual(['商品列表.csv']);
    // BOM first so Excel reads UTF-8; a formula-looking name is written as text.
    expect(await blobs[0]!.text()).toBe(
      '\uFEFF"ID","商品名称"\r\n' +
        '"1","简约白 T 恤"\r\n' +
        '"2","\'=HYPERLINK(""https://evil.example"",""点我"")"',
    );
    vi.unstubAllGlobals();
  });
});
