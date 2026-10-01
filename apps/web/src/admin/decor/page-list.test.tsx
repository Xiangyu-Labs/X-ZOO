import {
  decorDesignate,
  decorDesignations,
  decorDocumentCreate,
  decorDocumentList,
} from '@shop/contracts/decor/decor.admin.contract';
import type { ResponseOf } from '@shop/contracts/_conventions/route';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { DecorDocumentList } from './page-list';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push, back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/decor',
  useSearchParams: () => new URLSearchParams(),
}));

// The template thumbnails draw a real page: not what this test is about.
vi.mock('./editor', () => ({ DecorPagePreview: () => null }));

type Summary = ResponseOf<typeof decorDesignations>['home'] & object;

const revision = {
  id: '31',
  number: 2,
  note: '',
  authorAdminId: '1',
  restoredFrom: null,
  createdAt: '2026-09-01T10:00:00+08:00',
};

const base: Summary = {
  id: '1',
  kind: 'home',
  name: '当前首页',
  title: '首页',
  designation: 'home',
  draftVersion: '5',
  published: revision,
  hasUnpublishedChanges: false,
  createdAt: '2026-09-01T10:00:00+08:00',
  updatedAt: '2026-09-01T10:00:00+08:00',
};

const live = base;
const autumn: Summary = {
  ...base,
  id: '2',
  name: '秋季首页',
  designation: null,
  hasUnpublishedChanges: true,
};
const unpublished: Summary = {
  ...base,
  id: '3',
  name: '冬季首页草稿',
  designation: null,
  published: null,
  hasUnpublishedChanges: true,
};
const micro: Summary = { ...autumn, id: '4', kind: 'custom', name: '新品专题' };

function stubApi(): StubCall[] {
  return stubRoutes([
    on(decorDocumentList, {
      items: [live, autumn, unpublished, micro],
      total: 4,
      page: 1,
      pageSize: 20,
    }),
    on(decorDesignations, { home: live, user_center: null }),
    on(decorDesignate, { home: autumn, user_center: null }),
    on(decorDocumentCreate, {
      ...micro,
      id: '9',
      name: '周末活动',
      draft: { schemaVersion: 2, root: { props: { title: '周末活动' } }, blocks: [] },
      issues: [],
      warnings: [],
    }),
  ]);
}

const everything = {
  ...testIdentity,
  permissions: ['decor:page:read', 'decor:page:write', 'decor:page:publish'],
};

function rowOf(name: string): HTMLElement {
  const links = screen.getAllByRole('link', { name });
  const row = links.map((link) => link.closest('tr')).find(Boolean);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

afterEach(() => {
  resetApiConfig();
  push.mockReset();
});

describe('店铺装修列表', () => {
  it('shows the designations, the live revision and unpublished changes', async () => {
    stubApi();
    renderAdmin(<DecorDocumentList />, { identity: everything });

    await screen.findByRole('cell', { name: /秋季首页/ });
    expect(
      within(rowOf('当前首页')).getByText('当前首页', { selector: '.ant-tag' }),
    ).toBeInTheDocument();
    expect(within(rowOf('秋季首页')).getByText('有未发布修改')).toBeInTheDocument();
    expect(within(rowOf('冬季首页草稿')).getByText('未发布')).toBeInTheDocument();
    expect(screen.getAllByText('店铺装修').length).toBeGreaterThan(0);
    expect(screen.queryByText('新版')).not.toBeInTheDocument();
  });

  it('designates only a published page of the matching kind, after a confirm', async () => {
    const calls = stubApi();
    renderAdmin(<DecorDocumentList />, { identity: everything });
    await screen.findByRole('cell', { name: /秋季首页/ });

    expect(within(rowOf('当前首页')).getByRole('button', { name: '设为首页' })).toBeDisabled();
    expect(within(rowOf('冬季首页草稿')).getByRole('button', { name: '设为首页' })).toBeDisabled();
    expect(within(rowOf('新品专题')).queryByRole('button', { name: '设为首页' })).toBeNull();

    await userEvent.click(within(rowOf('秋季首页')).getByRole('button', { name: '设为首页' }));
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    const confirm = await screen.findByRole('tooltip');
    expect(confirm).toHaveTextContent('原来的「当前首页」不再使用');
    await userEvent.click(within(confirm).getByRole('button', { name: zhName('确定') }));

    await waitFor(() => {
      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.path).toBe('/admin-api/decor/designations/home');
      expect(put?.body).toEqual({ documentId: '2' });
    });
  });

  it('never deletes the page in use', async () => {
    stubApi();
    renderAdmin(<DecorDocumentList />, { identity: everything });
    await screen.findByRole('cell', { name: /秋季首页/ });

    expect(within(rowOf('当前首页')).getByRole('button', { name: zhName('删除') })).toBeDisabled();
    expect(within(rowOf('秋季首页')).getByRole('button', { name: zhName('删除') })).toBeEnabled();
  });

  it('hides every change from an admin who may only look', async () => {
    stubApi();
    renderAdmin(<DecorDocumentList />, {
      identity: { ...testIdentity, permissions: ['decor:page:read'] },
    });
    await screen.findByRole('cell', { name: /秋季首页/ });

    for (const name of ['新建页面', '重命名', '复制', '设为首页', '删除']) {
      expect(screen.queryByRole('button', { name: zhName(name) })).toBeNull();
    }
    expect(within(rowOf('秋季首页')).getByRole('link', { name: '装修' })).toHaveAttribute(
      'href',
      '/admin/decor/2',
    );
  });

  it('creates a page from the chosen kind and opens it', async () => {
    const calls = stubApi();
    renderAdmin(<DecorDocumentList />, { identity: everything });
    await screen.findByRole('cell', { name: /秋季首页/ });

    await userEvent.click(screen.getByRole('button', { name: '新建页面' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('页面名称'), '周末活动');
    expect(within(dialog).getByRole('button', { name: '空白页面' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: '创建并装修' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/decor/9'));
    const create = calls.find((call) => call.method === 'POST');
    expect(create?.path).toBe('/admin-api/decor/documents');
    expect(create?.body).toEqual({ kind: 'custom', name: '周末活动' });
  });
});
