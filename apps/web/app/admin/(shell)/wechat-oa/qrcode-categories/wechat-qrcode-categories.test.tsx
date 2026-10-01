import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { WechatQrcodeCategory } from '@shop/contracts/wechat-oa/schemas';
import {
  wechatOaQrcodeCategoryCreate,
  wechatOaQrcodeCategoryDelete,
  wechatOaQrcodeCategoryList,
  wechatOaQrcodeCategoryUpdate,
} from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { WechatQrcodeCategoriesPage } from './wechat-qrcode-categories';

const empty: WechatQrcodeCategory = {
  id: '2',
  name: '线上投放',
  sortOrder: 1,
  qrcodeCount: 0,
  createdAt: '2026-01-04T10:00:00+08:00',
};
const occupied: WechatQrcodeCategory = {
  id: '1',
  name: '线下门店',
  sortOrder: 0,
  qrcodeCount: 3,
  createdAt: '2026-01-04T10:00:00+08:00',
};

function stubApi(): StubCall[] {
  return stubRoutes([
    on(wechatOaQrcodeCategoryList, { items: [occupied, empty], total: 2, page: 1, pageSize: 20 }),
    on(wechatOaQrcodeCategoryCreate, occupied),
    on(wechatOaQrcodeCategoryUpdate, occupied),
    on(wechatOaQrcodeCategoryDelete, undefined),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const allPermissions = {
  ...testIdentity,
  permissions: ['wechat-oa:qrcode:read', 'wechat-oa:qrcode:write'],
};

describe('渠道码分类', () => {
  it('lists categories with how many codes are filed under each', async () => {
    const calls = stubApi();
    renderAdmin(<WechatQrcodeCategoriesPage />, { identity: allPermissions });

    expect(await screen.findByText('线下门店')).toBeInTheDocument();
    expect(screen.getByText('线上投放')).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/admin-api/wechat-qrcode-categories?');
  });

  it('refuses to delete a category that still holds codes, before the request', async () => {
    stubApi();
    renderAdmin(<WechatQrcodeCategoriesPage />, { identity: allPermissions });
    await screen.findByText('线下门店');

    const rows = screen.getAllByRole('row');
    const occupiedRow = rows.find((row) => within(row).queryByText('线下门店'));
    const emptyRow = rows.find((row) => within(row).queryByText('线上投放'));

    // `WECHAT_OA_CATEGORY_NOT_EMPTY` explained after the fact is a worse screen
    // than a button that cannot be pressed.
    expect(within(occupiedRow!).getByRole('button', { name: zhName('删除') })).toBeDisabled();
    expect(within(emptyRow!).getByRole('button', { name: zhName('删除') })).toBeEnabled();
  });

  it('creates a category through the contract route', { timeout: 20_000 }, async () => {
    const calls = stubApi();
    renderAdmin(<WechatQrcodeCategoriesPage />, { identity: allPermissions });
    await screen.findByText('线下门店');

    await userEvent.click(screen.getByRole('button', { name: zhName('新建分类') }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('名称'), '合作商家');
    await userEvent.click(within(dialog).getByRole('button', { name: zhName('保存') }));

    await waitFor(() => {
      const save = calls.find((call) => call.method === 'POST');
      expect(save?.url).toContain('/admin-api/wechat-qrcode-categories');
      expect(save?.body).toMatchObject({ name: '合作商家' });
    });
  });

  it('hides every write action from a read-only admin', async () => {
    stubApi();
    renderAdmin(<WechatQrcodeCategoriesPage />, {
      identity: { ...testIdentity, permissions: ['wechat-oa:qrcode:read'] },
    });

    await screen.findByText('线下门店');
    expect(screen.queryByRole('button', { name: zhName('新建分类') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('编辑') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('删除') })).not.toBeInTheDocument();
  });
});
