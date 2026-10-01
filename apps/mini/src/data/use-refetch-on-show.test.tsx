import type { ReactNode } from 'react';
import { QueryClientProvider, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testQueryClient } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import {
  LIST_FULL_RELOAD_AFTER_MS,
  useRefetchOnShow,
  type RefetchOnShowOptions,
} from './use-refetch-on-show';

function setup(staleTime: number, options: RefetchOnShowOptions = {}) {
  let fetches = 0;
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      useRefetchOnShow(['greeting'], options);
      return useQuery({
        queryKey: ['greeting'],
        queryFn: async () => `hello ${++fetches}`,
        staleTime,
      });
    },
    { wrapper },
  );
  return { hook, client, fetches: () => fetches };
}

describe('useRefetchOnShow', () => {
  it('refetches a stale query when the page is shown again, not on the first show', async () => {
    const { hook, fetches } = setup(0);
    await waitFor(() => expect(hook.result.current.data).toBe('hello 1'));
    expect(fetches()).toBe(1);

    act(() => taroFake.showPage());
    await waitFor(() => expect(hook.result.current.data).toBe('hello 2'));
  });

  it('leaves a fresh query alone', async () => {
    const { hook, fetches } = setup(60_000);
    await waitFor(() => expect(hook.result.current.data).toBe('hello 1'));

    act(() => taroFake.showPage());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetches()).toBe(1);
  });

  it('refetches a fresh query too when asked to on every show', async () => {
    const { hook, fetches } = setup(60_000, { when: 'always' });
    await waitFor(() => expect(hook.result.current.data).toBe('hello 1'));
    expect(fetches()).toBe(1);

    act(() => taroFake.showPage());
    await waitFor(() => expect(hook.result.current.data).toBe('hello 2'));
  });

  it('refetches only a read a change marked stale when asked for invalidated ones', async () => {
    const { hook, fetches, client } = setup(0, { when: 'invalidated' });
    await waitFor(() => expect(hook.result.current.data).toBe('hello 1'));

    // Past its staleTime, but nothing changed: left alone.
    act(() => taroFake.showPage());
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetches()).toBe(1);

    await act(() => client.invalidateQueries({ queryKey: ['greeting'], refetchType: 'none' }));
    expect(fetches()).toBe(1);
    act(() => taroFake.showPage());
    await waitFor(() => expect(hook.result.current.data).toBe('hello 2'));
  });
});

describe('useRefetchOnShow, pages: first', () => {
  /** A list of 3 pages of 2; each fetch of a page says which round it was (`p1#2`). */
  function setupList(staleTime: number, options: RefetchOnShowOptions = { pages: 'first' }) {
    const asked: number[] = [];
    const rounds = new Map<number, number>();
    // When set, the next fetch waits for it (after taking its round number).
    const gate: { next: Promise<void> | null } = { next: null };
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () => {
        useRefetchOnShow(['orders'], options);
        return useInfiniteQuery({
          queryKey: ['orders', {}, 'infinite'],
          initialPageParam: 1,
          getNextPageParam: (last: { page: number }) => (last.page < 3 ? last.page + 1 : undefined),
          queryFn: async ({ pageParam }) => {
            asked.push(pageParam);
            const round = (rounds.get(pageParam) ?? 0) + 1;
            rounds.set(pageParam, round);
            const wait = gate.next;
            gate.next = null;
            if (wait) await wait;
            return { page: pageParam, items: [`p${pageParam}#${round}`] };
          },
          staleTime,
        });
      },
      { wrapper },
    );
    const items = () => hook.result.current.data?.pages.flatMap((page) => page.items);
    return { hook, client, asked, items, gate };
  }

  async function scrollToEnd(hook: ReturnType<typeof setupList>['hook']) {
    for (const length of [1, 2, 3]) {
      await waitFor(() => expect(hook.result.current.data?.pages).toHaveLength(length));
      if (length < 3) await act(() => hook.result.current.fetchNextPage());
    }
  }

  it('fetches only page 1 of a stale list again, keeping the pages after it', async () => {
    const { hook, asked, items } = setupList(0);
    await scrollToEnd(hook);
    expect(items()).toEqual(['p1#1', 'p2#1', 'p3#1']);

    act(() => taroFake.showPage());
    await waitFor(() => expect(items()).toEqual(['p1#2', 'p2#1', 'p3#1']));
    expect(asked).toEqual([1, 2, 3, 1]);
  });

  it('leaves a fresh list alone', async () => {
    const { hook, asked } = setupList(60_000);
    await scrollToEnd(hook);

    act(() => taroFake.showPage());
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked).toEqual([1, 2, 3]);
  });

  it('fetches every page of a list a change marked stale', async () => {
    const { hook, client, asked, items } = setupList(60_000);
    await scrollToEnd(hook);

    await act(() => client.invalidateQueries({ queryKey: ['orders'], refetchType: 'none' }));
    act(() => taroFake.showPage());
    await waitFor(() => expect(items()).toEqual(['p1#2', 'p2#2', 'p3#2']));
    expect(asked).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('refetches a one-page list as usual', async () => {
    const { hook, asked, items } = setupList(0);
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    act(() => taroFake.showPage());
    await waitFor(() => expect(items()).toEqual(['p1#2']));
    expect(asked).toEqual([1, 1]);
  });

  it('drops page 1 when the list was fetched again while it was on its way', async () => {
    const { hook, client, items, gate } = setupList(0);
    await scrollToEnd(hook);
    const query = client.getQueryCache().find({ queryKey: ['orders', {}, 'infinite'] });
    if (!query) throw new Error('no query');

    let release = () => undefined as void;
    gate.next = new Promise((resolve) => (release = resolve));
    const { refetchFirstPage } = await import('./use-refetch-on-show');
    const pending = refetchFirstPage(client, query); // takes round 2 of page 1, then waits
    // A pull-down lands first: every page again.
    await act(() => hook.result.current.refetch());
    await waitFor(() => expect(items()).toEqual(['p1#3', 'p2#2', 'p3#2']));

    release();
    await act(() => pending);
    // The older page 1 (round 2) is not put over the newer copy.
    const cached = client.getQueryData<{ pages: Array<{ items: string[] }> }>(query.queryKey);
    expect(cached?.pages.flatMap((page) => page.items)).toEqual(['p1#3', 'p2#2', 'p3#2']);
  });

  describe('allPagesAfter (away long enough)', () => {
    const LONG = { pages: 'first', allPagesAfter: LIST_FULL_RELOAD_AFTER_MS } as const;

    afterEach(() => {
      vi.useRealTimers();
    });

    /** Hides the page, lets `ms` pass on the clock, and shows it again. */
    function away(ms: number) {
      act(() => taroFake.hidePage());
      vi.setSystemTime(Date.now() + ms);
      act(() => taroFake.showPage());
    }

    it('fetches every page again, from page 1, after 5 minutes away', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { hook, asked, items } = setupList(0, LONG);
      await scrollToEnd(hook);

      away(LIST_FULL_RELOAD_AFTER_MS);
      await waitFor(() => expect(items()).toEqual(['p1#2', 'p2#2', 'p3#2']));
      expect(asked).toEqual([1, 2, 3, 1, 2, 3]);
    });

    it('fetches only page 1 after a shorter trip', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { hook, asked, items } = setupList(0, LONG);
      await scrollToEnd(hook);

      away(LIST_FULL_RELOAD_AFTER_MS - 1000);
      await waitFor(() => expect(items()).toEqual(['p1#2', 'p2#1', 'p3#1']));
      expect(asked).toEqual([1, 2, 3, 1]);

      // Measured per trip: the time before this hide does not count towards the next one.
      away(LIST_FULL_RELOAD_AFTER_MS - 1000);
      await waitFor(() => expect(items()).toEqual(['p1#3', 'p2#1', 'p3#1']));
      expect(asked).toEqual([1, 2, 3, 1, 1]);
    });

    it('still leaves a list alone that is fresh when the shopper comes back', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { hook, asked } = setupList(2 * LIST_FULL_RELOAD_AFTER_MS, LONG);
      await scrollToEnd(hook);

      away(LIST_FULL_RELOAD_AFTER_MS);
      await act(async () => {
        await Promise.resolve();
      });
      expect(asked).toEqual([1, 2, 3]);
    });
  });
});
