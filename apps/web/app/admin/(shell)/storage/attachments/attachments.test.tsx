import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  storageAttachmentDeleteMany,
  storageAttachmentList,
  storageCategoryTree,
} from '@shop/contracts/storage/storage.admin.contract';
import {
  attachmentCategoryNodeExample,
  attachmentItemExample,
} from '@shop/contracts/storage/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

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

const CLIP = {
  ...attachmentItemExample,
  id: '902',
  kind: 'video' as const,
  name: '开箱视频',
  mime: 'video/mp4',
  url: '/uploads/2026/10/clip.mp4',
  width: null,
  height: null,
};

function stubApi(items = [attachmentItemExample]) {
  return stubRoutes([
    on(storageAttachmentList, {
      items,
      total: items.length,
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

  it('plays a video when its preview is clicked', async () => {
    stubApi([attachmentItemExample, CLIP]);
    renderAdmin(<AttachmentsPage />, {
      identity: { ...testIdentity, permissions: ['storage:attachment:read'] },
    });
    fireEvent.click(await screen.findByRole('button', { name: '播放开箱视频' }));
    const player = (await screen.findByTestId('video-player')) as HTMLVideoElement;
    expect(player.getAttribute('src')).toBe(CLIP.url);
    expect(player.controls).toBe(true);
  });

  it('warns instead of saying 已删除 when single-row delete affects 0 rows', async () => {
    stubRoutes([
      on(storageAttachmentList, {
        items: [attachmentItemExample],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
      on(storageAttachmentDeleteMany, { affected: 0, skippedIds: [attachmentItemExample.id] }),
    ]);
    renderAdmin(<AttachmentsPage />, {
      identity: {
        ...testIdentity,
        permissions: ['storage:attachment:read', 'storage:attachment:delete'],
      },
    });
    await screen.findByText('首页 banner');

    await userEvent.click(screen.getByRole('button', { name: zhName('删除') }));
    const popup = (await screen.findByText(`删除素材「${attachmentItemExample.name}」？`)).closest(
      '.ant-popover',
    ) as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('确定') }));

    expect(await screen.findByText('该素材已不存在')).toBeInTheDocument();
    expect(screen.queryByText('已删除')).toBeNull();
  });

  it('shows a Chinese error when copying link fails or clipboard is unavailable', async () => {
    stubApi();
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
    });
    try {
      renderAdmin(<AttachmentsPage />, {
        identity: { ...testIdentity, permissions: ['storage:attachment:read'] },
      });
      await screen.findByText('首页 banner');
      await userEvent.click(screen.getByRole('button', { name: '复制链接' }));
      await waitFor(() => expect(screen.getByText('复制失败，请手动复制')).toBeInTheDocument());
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
    }
  });
});
