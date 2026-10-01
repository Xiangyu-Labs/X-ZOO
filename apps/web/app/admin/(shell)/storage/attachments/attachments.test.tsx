import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  storageAttachmentList,
  storageCategoryTree,
} from '@shop/contracts/storage/storage.admin.contract';
import {
  attachmentCategoryNodeExample,
  attachmentItemExample,
} from '@shop/contracts/storage/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { AttachmentsPage } from './attachments';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/storage/attachments',
  useSearchParams: () => new URLSearchParams(''),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

afterEach(() => {
  resetApiConfig();
});

function stubApi() {
  return stubRoutes([
    on(storageAttachmentList, {
      items: [attachmentItemExample],
      total: 1,
      page: 1,
      pageSize: 20,
    }),
    on(storageCategoryTree, { items: [attachmentCategoryNodeExample] }),
  ]);
}

const categoryRequests = (calls: ReturnType<typeof stubApi>) =>
  calls.filter(
    (call) => new URL(call.url, 'http://x').pathname === '/admin-api/attachment-categories',
  );

describe('素材库', () => {
  it('shows the folder tree to a role that may read 分组', async () => {
    const calls = stubApi();
    renderAdmin(<AttachmentsPage />, {
      identity: {
        ...testIdentity,
        permissions: ['storage:attachment:read', 'storage:category:read'],
      },
    });
    expect(await screen.findByText('首页 banner')).toBeInTheDocument();
    expect(await screen.findByText(/商品图/)).toBeInTheDocument();
    expect(categoryRequests(calls).length).toBeGreaterThan(0);
  });

  it('lists the files without the tree, and without asking for it, for a role that may not read 分组', async () => {
    const calls = stubApi();
    renderAdmin(<AttachmentsPage />, {
      identity: { ...testIdentity, permissions: ['storage:attachment:read'] },
    });
    expect(await screen.findByText('首页 banner')).toBeInTheDocument();
    expect(screen.queryByText(/商品图/)).toBeNull();
    expect(categoryRequests(calls)).toEqual([]);
  });
});
