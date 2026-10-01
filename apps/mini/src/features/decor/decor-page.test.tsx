import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppConfigStore, type AppConfig } from '@/app-config';
import { useSession } from '@/session/session';
import { appConfigFixture } from '@/test/app-config-fixture';
import { resolvedPageFixture } from '@/test/decor-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import { DecorPage, type ResolvedPage } from './decor-page';

const style = { marginY: 'none', paddingX: 'none', radius: 'none' } as const;
const visibility = { audience: 'all', platforms: [] } as const;

/** 我的卡片 and a 服务 grid whose second cell is 联系客服, as the 我的 page's defaults. */
const page = (personal: ResolvedPage['personal'] = null): ResolvedPage =>
  resolvedPageFixture({
    personal,
    blocks: [
      {
        id: 'b-user',
        type: 'userCard',
        v: 1,
        props: { showStats: true, style, visibility },
        data: {},
      },
      {
        id: 'b-service',
        type: 'serviceGrid',
        v: 1,
        props: {
          title: '我的服务',
          columns: 4,
          items: [
            {
              label: '收货地址',
              action: 'link',
              link: { kind: 'route', to: { route: 'addresses', params: {} } },
            },
            { label: '联系客服', action: 'contact' },
          ],
          style,
          visibility,
        },
        data: {},
      },
      {
        id: 'b-text',
        type: 'richText',
        v: 1,
        props: { html: '<p>七天无理由退换</p>', style, visibility },
        data: {},
      },
    ],
  });

const reload = () => undefined;

const withSupport = (support: AppConfig['support']) =>
  useAppConfigStore.setState({ config: { ...appConfigFixture, support }, source: 'network' });

describe('DecorPage', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'idle' } });
    withSupport(appConfigFixture.support);
  });

  it('wraps 联系客服 in WeChat’s contact button, with the page as the session source', async () => {
    await renderPage(
      <DecorPage page={page()} route={{ route: 'page', params: { id: '7' } }} reload={reload} />,
    );

    const contact = screen.getByRole('button', { name: '联系客服' });
    expect(contact.getAttribute('data-open-type')).toBe('contact');
    expect(contact.getAttribute('data-session-from')).toBe('route:page;id:7');
    expect(screen.getByText('七天无理由退换')).toBeTruthy();
  });

  it('makes 联系客服 a call when the shop has a hotline, and leaves the cell empty when it has nothing', async () => {
    withSupport({ kind: 'phone', phone: '400-000-0000', qrcodeUrl: null });
    const { unmount } = await renderPage(
      <DecorPage page={page()} route={{ route: 'home', params: {} }} reload={reload} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '拨打客服电话 400-000-0000' }));
    expect(taroFake.calls).toContainEqual({
      api: 'makePhoneCall',
      args: { phoneNumber: '400-000-0000' },
    });
    unmount();

    withSupport(null as unknown as AppConfig['support']);
    await renderPage(
      <DecorPage page={page()} route={{ route: 'home', params: {} }} reload={reload} />,
    );
    expect(screen.queryByText('联系客服')).toBeNull();
    expect(screen.getByText('收货地址')).toBeTruthy();
  });

  it('sends a signed-out shopper from 我的卡片 to login, coming back to this page', async () => {
    taroFake.loginCode = 'code-1';
    serveApi({
      'POST /api/v1/auth/sessions/wechat-mini': () => ({
        status: 201,
        body: {
          status: 'phone-required',
          session: null,
          registered: false,
          bindToken: 'bind-1',
          bindTokenExpiresInSec: 600,
        },
      }),
    });
    await renderPage(
      <DecorPage page={page()} route={{ route: 'home', params: {} }} reload={reload} />,
    );

    fireEvent.click(screen.getByText('登录 / 注册'));

    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: {
          url: `/pages/login/index?redirect=${encodeURIComponent(JSON.stringify({ route: 'home', params: {} }))}`,
        },
      }),
    );
  });

  it('shows the shopper’s own card when the page carries their personal slots', async () => {
    await renderPage(
      <DecorPage
        page={page({
          'b-user': {
            user: {
              kind: 'userSummary',
              user: {
                nickname: '小林',
                avatarUrl: null,
                stats: { coupons: 3, favorites: 12, history: 28 },
              },
            },
          },
        })}
        route={{ route: 'home', params: {} }}
        reload={reload}
      />,
    );

    expect(screen.getByText('小林')).toBeTruthy();
    expect(screen.queryByText('登录 / 注册')).toBeNull();
  });
});
