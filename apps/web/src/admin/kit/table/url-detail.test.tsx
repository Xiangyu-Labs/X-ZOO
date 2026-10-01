import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUrlDetailId } from './url-state';

let search = new URLSearchParams();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/trade/refunds',
  useSearchParams: () => search,
}));

afterEach(() => {
  search = new URLSearchParams();
  replace.mockReset();
});

describe('NOTIF-008 — a ?detail= link opens that record on the list page', () => {
  it('opens the drawer on the id in the link', () => {
    search = new URLSearchParams('detail=12');
    const { result } = renderHook(() => useUrlDetailId());
    expect(result.current[0]).toBe('12');
  });

  it('follows a second link while the page is open', () => {
    search = new URLSearchParams('detail=12');
    const { result, rerender } = renderHook(() => useUrlDetailId());
    search = new URLSearchParams('detail=13');
    rerender();
    expect(result.current[0]).toBe('13');
  });

  it('closing drops ?detail= and keeps the filters, so a refresh does not reopen it', () => {
    search = new URLSearchParams('status=pending&detail=12');
    const { result } = renderHook(() => useUrlDetailId());
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    expect(replace).toHaveBeenCalledWith('/admin/trade/refunds?status=pending', { scroll: false });
  });

  it('without the parameter the page opens closed, and a row click touches no URL', () => {
    const { result } = renderHook(() => useUrlDetailId());
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]('7'));
    expect(result.current[0]).toBe('7');
    act(() => result.current[1](null));
    expect(replace).not.toHaveBeenCalled();
  });
});
