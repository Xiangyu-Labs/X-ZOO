import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  fixtureOrderEntry,
  fixturePersonal,
  fixtureServiceGrid,
  fixtureUserCard,
} from '@shop/storefront-blocks/fixtures';
import { signIn, signOut } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import Me from './index';

function userCenter(signedIn: boolean) {
  return {
    id: null,
    kind: 'user_center',
    revision: null,
    preview: false,
    root: {
      props: { title: '个人中心', background: '#f5f5f5', shareEnabled: false, shareTitle: '' },
    },
    blocks: [
      { id: 'userCard', type: 'userCard', v: 1, props: fixtureUserCard, data: {} },
      { id: 'orderEntry', type: 'orderEntry', v: 1, props: fixtureOrderEntry, data: {} },
      { id: 'services', type: 'serviceGrid', v: 1, props: fixtureServiceGrid, data: {} },
    ],
    personal: signedIn ? fixturePersonal : null,
    version: 'v1',
    resolvedAt: '2026-09-24T10:00:00+08:00',
  };
}

/** The tab bar's badge reads it once the shopper is signed in. */
const EMPTY_CART_COUNT = { items: 0, quantity: 0, availableCount: 0, unavailableCount: 0 };

describe('我的', () => {
  it('draws the decorated 个人中心 with the shopper, and the unread messages', async () => {
    signIn();
    serveApi({
      'GET /api/v1/pages/user-center': () => ({ body: userCenter(true) }),
      'GET /api/v1/my-messages/unread-count': () => ({ body: { unread: 2 } }),
      'GET /api/v1/cart/count': () => ({ body: EMPTY_CART_COUNT }),
    });
    await renderPage(<Me />);

    expect(await screen.findByText('小林')).toBeTruthy();
    fireEvent.click(screen.getByText('我的收藏'));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/account/favorites/index' },
      }),
    );
    fireEvent.click(await screen.findByRole('link', { name: '2 条未读消息' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/account/messages/index' },
      }),
    );
  });

  it('shows a guest 登录 / 注册, and reloads the page once signed in', async () => {
    signOut();
    let signedIn = false;
    const seen = serveApi({
      'GET /api/v1/pages/user-center': () => ({ body: userCenter(signedIn) }),
      'GET /api/v1/my-messages/unread-count': () => ({ body: { unread: 0 } }),
      'GET /api/v1/cart/count': () => ({ body: EMPTY_CART_COUNT }),
    });
    await renderPage(<Me />);

    expect(await screen.findByText('登录 / 注册')).toBeTruthy();
    expect(seen.map((r) => r.key)).not.toContain('GET /api/v1/my-messages/unread-count');

    signedIn = true;
    act(() => signIn());
    expect(await screen.findByText('小林')).toBeTruthy();
    expect(seen.filter((r) => r.key === 'GET /api/v1/pages/user-center')).toHaveLength(2);
  });

  it('asks for the counts again every time it is shown, even within the 30 s staleTime', async () => {
    signIn();
    const seen = serveApi({
      'GET /api/v1/pages/user-center': () => ({ body: userCenter(true) }),
      'GET /api/v1/my-messages/unread-count': () => ({ body: { unread: 0 } }),
      'GET /api/v1/cart/count': () => ({ body: EMPTY_CART_COUNT }),
    });
    // The app's own freshness window: a read younger than 30 s is not stale.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 30_000 } },
    });
    await renderPage(<Me />, client);
    expect(await screen.findByText('小林')).toBeTruthy();
    const pageReads = () => seen.filter((r) => r.key === 'GET /api/v1/pages/user-center').length;
    expect(pageReads()).toBe(1);

    // Paid on another page a moment later, then back on 我的: the 待付款 badge must move.
    act(() => taroFake.showPage());
    await waitFor(() => expect(pageReads()).toBe(2));
    expect(
      seen.filter((r) => r.key === 'GET /api/v1/my-messages/unread-count').length,
    ).toBeGreaterThanOrEqual(2);
  });
});
