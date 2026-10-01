import { ApiError } from '@shop/api-client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { Empty } from './empty';
import { InfiniteList, type PagedListState } from './infinite-list';

function state(overrides: Partial<PagedListState<string>> = {}): PagedListState<string> {
  return {
    data: { pages: [{ items: ['苹果', '香蕉'] }] },
    isPending: false,
    isError: false,
    error: null,
    hasNextPage: true,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: vi.fn(() => Promise.resolve()),
    refetch: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function List({ query, active }: { query: PagedListState<string>; active?: boolean }) {
  return (
    <InfiniteList
      query={query}
      itemKey={(item) => item}
      renderItem={(item) => <span>{item}</span>}
      empty={<Empty title="暂无商品" />}
      skeleton={<span>骨架</span>}
      columns={2}
      active={active}
    />
  );
}

describe('InfiniteList', () => {
  it('shows the skeleton, then the items of every page', () => {
    const { rerender } = render(<List query={state({ isPending: true, data: undefined })} />);
    expect(screen.getByText('骨架')).toBeTruthy();
    rerender(
      <List query={state({ data: { pages: [{ items: ['苹果'] }, { items: ['香蕉'] }] } })} />,
    );
    expect(screen.getByText('苹果')).toBeTruthy();
    expect(screen.getByText('香蕉')).toBeTruthy();
  });

  it('shows a row that two overlapping pages both carry once', () => {
    render(
      <List
        query={state({
          data: { pages: [{ items: ['梨', '苹果', '香蕉'] }, { items: ['香蕉', '橙子'] }] },
        })}
      />,
    );
    expect(screen.getAllByText('香蕉')).toHaveLength(1);
    expect(screen.getAllByText(/^(梨|苹果|香蕉|橙子)$/).map((node) => node.textContent)).toEqual([
      '梨',
      '苹果',
      '香蕉',
      '橙子',
    ]);
  });

  it('loads the next page at the bottom, and only one at a time', () => {
    const query = state();
    render(<List query={query} />);
    act(() => taroFake.reachBottom());
    expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
    const busy = state({ isFetchingNextPage: true });
    render(<List query={busy} />);
    expect(screen.getByText('加载中…')).toBeTruthy();
  });

  it('leaves the next page until a refresh of the list is done', () => {
    const query = state({ isFetching: true });
    render(<List query={query} />);
    act(() => taroFake.reachBottom());
    expect(query.fetchNextPage).not.toHaveBeenCalled();
  });

  it('ignores the bottom when it is not the list on screen', () => {
    const query = state();
    render(<List query={query} active={false} />);
    act(() => taroFake.reachBottom());
    expect(query.fetchNextPage).not.toHaveBeenCalled();
  });

  it('says 没有更多了 at the end, and offers a retry when a page failed', () => {
    const { rerender } = render(<List query={state({ hasNextPage: false })} />);
    expect(screen.getByText('没有更多了')).toBeTruthy();
    const failed = state({ isFetchNextPageError: true });
    rerender(<List query={failed} />);
    fireEvent.click(screen.getByRole('button', { name: '加载失败，点击重试' }));
    expect(failed.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('refreshes on pull-down and puts the spinner away', async () => {
    const query = state();
    render(<List query={query} />);
    await act(async () => {
      taroFake.pullDown();
      await Promise.resolve();
    });
    expect(query.refetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(taroFake.calls.some((call) => call.api === 'stopPullDownRefresh')).toBe(true),
    );
  });

  it('is empty or a full error when there is nothing to show', () => {
    const { rerender } = render(
      <List query={state({ data: { pages: [{ items: [] }] }, hasNextPage: false })} />,
    );
    expect(screen.getByText('暂无商品')).toBeTruthy();
    const failed = state({
      data: undefined,
      isError: true,
      error: new ApiError({ status: 0, code: 'NETWORK', message: 'x' }),
    });
    rerender(<List query={failed} />);
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(failed.refetch).toHaveBeenCalledTimes(1);
  });
});
