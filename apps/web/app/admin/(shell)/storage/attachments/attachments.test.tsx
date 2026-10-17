import { fireEvent, screen } from '@testing-library/react';
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
});
