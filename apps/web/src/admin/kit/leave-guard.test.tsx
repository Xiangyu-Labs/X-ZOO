import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Link from 'next/link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '@/test/render';

import { useLeaveGuard } from './leave-guard';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/catalog/products/7',
  useSearchParams: () => new URLSearchParams(),
}));

function Page({ dirty }: { dirty: boolean }) {
  const leave = useLeaveGuard(dirty);
  return (
    <>
      <Link href="/admin/orders">订单</Link>
      <button type="button" onClick={() => leave('/admin/catalog/products')}>
        返回列表
      </button>
    </>
  );
}

function prompt(): HTMLElement | null {
  const all = document.querySelectorAll('.ant-modal-confirm');
  const last = all[all.length - 1];
  return last instanceof HTMLElement ? last : null;
}

afterEach(() => {
  push.mockReset();
});

describe('useLeaveGuard', () => {
  it('asks before an in-app link drops unsaved work, and 仍然离开 goes where it pointed', async () => {
    const user = userEvent.setup();
    renderAdmin(<Page dirty />);

    await user.click(screen.getByRole('link', { name: '订单' }));
    await waitFor(() => expect(prompt()).toHaveTextContent('有未保存的修改'));
    expect(push).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '仍然离开' }));
    expect(push).toHaveBeenCalledWith('/admin/orders');
  });

  it('asks on the page’s own 返回列表 too, and 继续编辑 stays', async () => {
    const user = userEvent.setup();
    renderAdmin(<Page dirty />);

    await user.click(screen.getByRole('button', { name: '返回列表' }));
    await waitFor(() => expect(prompt()).toHaveTextContent('离开后这些修改会丢失'));
    await user.click(screen.getByRole('button', { name: '继续编辑' }));

    expect(push).not.toHaveBeenCalled();
  });

  it('asks nothing when there is nothing unsaved', async () => {
    const user = userEvent.setup();
    renderAdmin(<Page dirty={false} />);

    await user.click(screen.getByRole('button', { name: '返回列表' }));

    expect(push).toHaveBeenCalledWith('/admin/catalog/products');
    expect(prompt()).toBeNull();
  });
});
