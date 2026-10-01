import { QueryClient } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  userLabelCategoryList,
  userLabelCategoryUpdate,
  userLabelList,
} from '@shop/contracts/user/user.taxonomy.contract';
import { userLabelCategoryExample, userLabelExample } from '@shop/contracts/user/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { UserLabelsPage } from './labels';

afterEach(() => {
  resetApiConfig();
});

describe('用户标签', () => {
  it('renaming a 标签分类 refreshes the labels that show its name', async () => {
    let name = userLabelCategoryExample.name;
    stubRoutes([
      on(userLabelCategoryList, () => ({
        items: [{ ...userLabelCategoryExample, name }],
        total: 1,
        page: 1,
        pageSize: 100,
      })),
      on(userLabelList, () => ({
        items: [{ ...userLabelExample, categoryName: name }],
        total: 1,
        page: 1,
        pageSize: 20,
      })),
      on(userLabelCategoryUpdate, () => {
        name = '购物偏好';
        return { ...userLabelCategoryExample, name };
      }),
    ]);
    // Nothing goes stale on its own here: only the rename's invalidation can
    // make the labels tab fetch again.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    renderAdmin(<UserLabelsPage />, {
      identity: { ...testIdentity, permissions: ['user:label:read', 'user:label:write'] },
      queryClient,
    });
    await screen.findByText('母婴');

    await userEvent.click(screen.getByRole('tab', { name: '标签分类' }));
    // The tab swaps the table under it; only the categories' rows are on screen.
    await userEvent.click(await screen.findByRole('button', { name: zhName('编辑') }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('名称');
    await userEvent.clear(input);
    await userEvent.type(input, '购物偏好');
    await userEvent.click(within(dialog).getByRole('button', { name: zhName('保存') }));
    await screen.findByText('购物偏好');

    await userEvent.click(screen.getByRole('tab', { name: '标签' }));
    expect(await screen.findByText('购物偏好')).toBeInTheDocument();
    expect(screen.queryByText(userLabelCategoryExample.name)).not.toBeInTheDocument();
  });
});
