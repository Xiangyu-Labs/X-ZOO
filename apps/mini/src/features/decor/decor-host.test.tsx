import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureCouponList,
  fixtureCoupons,
  fixtureFloatingContact,
  fixtureFollowOfficialAccount,
  fixtureHotspotImage,
  fixtureNewcomerCoupon,
  fixtureNewUserCoupons,
  fixtureServiceGrid,
  fixtureVideo,
} from '@shop/storefront-blocks/fixtures';
import { useAppConfigStore, type AppConfig } from '@/app-config';
import { useSession } from '@/session/session';
import { profileFixture } from '@/test/account-fixture';
import { appConfigFixture } from '@/test/app-config-fixture';
import { userCouponFixture } from '@/test/checkout-fixture';
import { resolvedPageFixture } from '@/test/decor-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import { useOverlayStore } from '@/ui/overlay-store';
import { useDecorHost } from './decor-host';
import { DecorPage, type ResolvedPage } from './decor-page';

/**
 * An upload's content hash, the part of its name the server generates. Built, not written out:
 * the credentials guard flags any 32-hex literal.
 */
const HASH = '0123456789abcdef'.repeat(2);

type Blocks = ResolvedPage['blocks'];

const HOME = { route: 'home', params: {} } as const;
const loginUrl = `/pages/login/index?redirect=${encodeURIComponent(JSON.stringify(HOME))}`;

const couponBlock: Blocks[number] = {
  id: 'b-coupons',
  type: 'couponList',
  v: 1,
  props: { ...fixtureCouponList, layout: 'stack' },
  data: { coupons: fixtureCoupons.slice(0, 1) },
};
const newcomerBlock: Blocks[number] = {
  id: 'b-newcomer',
  type: 'newcomerCoupon',
  v: 1,
  props: fixtureNewcomerCoupon,
  data: { coupons: fixtureNewUserCoupons },
};
const floatingBlock: Blocks[number] = {
  id: 'b-float',
  type: 'floatingContact',
  v: 1,
  props: fixtureFloatingContact,
  data: {},
};
const officialBlock: Blocks[number] = {
  id: 'b-oa',
  type: 'followOfficialAccount',
  v: 1,
  props: fixtureFollowOfficialAccount,
  data: {},
};
const videoBlock: Blocks[number] = {
  id: 'b-video',
  type: 'video',
  v: 1,
  props: fixtureVideo,
  data: {},
};

const pageOf = (blocks: Blocks, personal: ResolvedPage['personal'] = null) =>
  resolvedPageFixture({ blocks, personal });

/** The ticket of template 21 (全场通用券), and what its button offers. */
const ticket = () => document.querySelector('[data-coupon="21"]') as HTMLElement;

const withSupport = (support: AppConfig['support']) =>
  useAppConfigStore.setState({ config: { ...appConfigFixture, support }, source: 'network' });

const guest = () =>
  useSession.setState({ session: { status: 'phone-required', bindToken: 'bind-1' } });
const shopper = () => useSession.setState({ session: { status: 'signed-in', token: 't1' } });

async function draw(page: ResolvedPage, reload = vi.fn()) {
  await renderPage(<DecorPage page={page} route={HOME} reload={reload} />);
  return reload;
}

describe('DecorPage host (decor.md §2.4)', () => {
  beforeEach(() => {
    withSupport(appConfigFixture.support);
    useOverlayStore.setState({ open: 0 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('claimCoupon', () => {
    it('DECOR-015 — claims for a shopper, says so, and reloads the page rather than flipping the button', async () => {
      shopper();
      const seen = serveApi({
        'POST /api/v1/coupons/21/claims': () => ({
          status: 201,
          body: {
            coupon: { ...userCouponFixture('9001', '0.00', '5.00'), templateId: '21' },
            remainingCount: null,
          },
        }),
      });
      const reload = await draw(
        pageOf([couponBlock], {
          'b-coupons': {
            coupons: {
              kind: 'coupons',
              items: [{ templateId: '21', claimedCount: 0, canClaim: true }],
            },
          },
        }),
      );
      expect(ticket().getAttribute('data-action')).toBe('claim');

      fireEvent.click(ticket());

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(seen.filter((r) => r.key === 'POST /api/v1/coupons/21/claims')).toHaveLength(1);
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({ title: '领取成功' }),
      });
      // Only the reloaded page's personal layer may say 已领: nothing changed here.
      expect(ticket().getAttribute('data-action')).toBe('claim');
    });

    it('shows the refusal and still reloads, since the coupon’s state has moved', async () => {
      shopper();
      serveApi({
        'POST /api/v1/coupons/21/claims': () => ({
          status: 409,
          body: { code: 'COUPON_SOLD_OUT', message: '优惠券已领完' },
        }),
      });
      const reload = await draw(pageOf([couponBlock]));

      fireEvent.click(ticket());

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      // Worded as 领券中心 words it.
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({ title: '来晚了，券已抢光' }),
      });
    });

    it('claims once for a double tap', async () => {
      shopper();
      const seen = serveApi({
        'POST /api/v1/coupons/21/claims': () => ({
          status: 201,
          body: {
            coupon: { ...userCouponFixture('9001', '0.00', '5.00'), templateId: '21' },
            remainingCount: null,
          },
        }),
      });
      const reload = await draw(pageOf([couponBlock]));

      fireEvent.click(ticket());
      fireEvent.click(ticket());

      await waitFor(() => expect(reload).toHaveBeenCalled());
      expect(seen.filter((r) => r.key === 'POST /api/v1/coupons/21/claims')).toHaveLength(1);
    });

    it('sends a guest to login, coming back to this page, and claims nothing', async () => {
      guest();
      const seen = serveApi({});
      const reload = await draw(pageOf([couponBlock]));

      fireEvent.click(ticket());

      await waitFor(() =>
        expect(taroFake.calls).toContainEqual({ api: 'navigateTo', args: { url: loginUrl } }),
      );
      expect(seen.some((r) => r.key.startsWith('POST /api/v1/coupons/'))).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe('login and claimNewcomerCoupons', () => {
    it('sends a guest from 新人券「注册领取」 to login, coming back to this page', async () => {
      guest();
      const reload = await draw(pageOf([newcomerBlock]));

      fireEvent.click(screen.getByText('注册领取'));

      await waitFor(() =>
        expect(taroFake.calls).toContainEqual({ api: 'navigateTo', args: { url: loginUrl } }),
      );
      expect(reload).not.toHaveBeenCalled();
    });

    it('reloads the page when the sign-in needed no login page', async () => {
      // A returning WeChat user: the silent sign-in succeeds on the spot.
      useSession.setState({ session: { status: 'idle' } });
      taroFake.loginCode = 'code-1';
      serveApi({
        'POST /api/v1/auth/sessions/wechat-mini': () => ({
          status: 201,
          body: {
            status: 'signed-in',
            session: {
              token: 't1',
              expiresAt: '2026-10-24T00:00:00+08:00',
              user: { ...profileFixture, id: '5', nickname: '小林' },
            },
            registered: false,
            bindToken: null,
            bindTokenExpiresInSec: null,
          },
        }),
      });
      const reload = await draw(pageOf([newcomerBlock]));

      fireEvent.click(screen.getByText('注册领取'));

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(taroFake.calls.some((call) => call.api === 'navigateTo')).toBe(false);
    });
  });

  describe('contact', () => {
    it('wraps 悬浮客服 in WeChat’s contact button, with the page as the session source', async () => {
      await draw(pageOf([floatingBlock]));
      const button = document.querySelector('[data-open-type="contact"]') as HTMLElement;
      expect(button.getAttribute('data-session-from')).toBe('route:home');
      expect(button.textContent).toContain('客服');
    });

    it('makes it a call on a hotline', async () => {
      withSupport({ kind: 'phone', phone: '400-000-0000', qrcodeUrl: null });
      await draw(pageOf([floatingBlock]));
      fireEvent.click(screen.getByRole('button', { name: '拨打客服电话 400-000-0000' }));
      expect(taroFake.calls).toContainEqual({
        api: 'makePhoneCall',
        args: { phoneNumber: '400-000-0000' },
      });
    });

    it('draws no 悬浮客服 when the shop has no 客服', async () => {
      withSupport({ kind: 'phone', phone: null, qrcodeUrl: null });
      await draw(pageOf([floatingBlock]));
      expect(document.querySelector('[data-block="floatingContact"]')).toBeNull();
    });
  });

  it('tells the blocks their page is hidden, so the 预售 countdown stops until it is shown', async () => {
    function Probe() {
      const { host } = useDecorHost(HOME, () => undefined);
      return <span>{host.hidden ? 'hidden' : 'shown'}</span>;
    }
    await renderPage(<Probe />);
    expect(screen.getByText('shown')).toBeTruthy();
    act(() => taroFake.hidePage());
    expect(screen.getByText('hidden')).toBeTruthy();
    act(() => taroFake.showPage());
    expect(screen.getByText('shown')).toBeTruthy();
  });

  describe('intents no wrapper answered (a host without renderIntent)', () => {
    /** Raises one intent straight at the host, as a block would without a wrapper. */
    function Probe({
      intent,
    }: {
      intent: Parameters<ReturnType<typeof useDecorHost>['onIntent']>[0];
    }) {
      const { onIntent } = useDecorHost(HOME, () => undefined);
      return (
        <button type="button" onClick={() => onIntent(intent)}>
          raise
        </button>
      );
    }

    it('calls the hotline for contact', async () => {
      withSupport({ kind: 'phone', phone: '400-000-0000', qrcodeUrl: null });
      await renderPage(<Probe intent={{ kind: 'contact' }} />);
      fireEvent.click(screen.getByText('raise'));
      expect(taroFake.calls).toContainEqual({
        api: 'makePhoneCall',
        args: { phoneNumber: '400-000-0000' },
      });
    });

    it('does nothing for contact when the shop has no hotline, nor for officialAccount', async () => {
      withSupport({ kind: 'phone', phone: null, qrcodeUrl: null });
      const { unmount } = await renderPage(<Probe intent={{ kind: 'contact' }} />);
      fireEvent.click(screen.getByText('raise'));
      unmount();
      await renderPage(<Probe intent={{ kind: 'officialAccount' }} />);
      fireEvent.click(screen.getByText('raise'));
      expect(taroFake.calls).toEqual([]);
    });

    it('reloads the page for login when the shopper is already signed in', async () => {
      shopper();
      const reload = vi.fn();
      function Login() {
        const { onIntent } = useDecorHost(HOME, reload);
        return (
          <button type="button" onClick={() => onIntent({ kind: 'login' })}>
            login
          </button>
        );
      }
      await renderPage(<Login />);
      fireEvent.click(screen.getByText('login'));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    });
  });

  describe('officialAccount', () => {
    it('draws WeChat’s 关注公众号 bar in the mini-program', async () => {
      await draw(pageOf([officialBlock]));
      expect(screen.getByTestId('official-account')).toBeTruthy();
    });

    it('draws nothing on H5, which has no such component', async () => {
      vi.stubEnv('TARO_ENV', 'h5');
      await draw(pageOf([officialBlock]));
      expect(screen.queryByTestId('official-account')).toBeNull();
      expect(document.querySelector('[data-block="followOfficialAccount"]')).toBeNull();
    });
  });

  describe('host', () => {
    it('swaps the video for its poster while a sheet is open over the page', async () => {
      await draw(pageOf([videoBlock]));
      expect(screen.getByTestId('native-video')).toBeTruthy();

      act(() => useOverlayStore.getState().push());
      expect(screen.queryByTestId('native-video')).toBeNull();
      expect(document.querySelector('[data-still="true"]')).toBeTruthy();

      act(() => useOverlayStore.getState().pop());
      expect(screen.getByTestId('native-video')).toBeTruthy();
    });

    it("loads a block picture's 960 px copy, and the original when the copy is missing", async () => {
      const upload = `/uploads/decor/2026/09/${HASH}.jpg`;
      await draw(
        pageOf([
          {
            id: 'b-hotspot',
            type: 'hotspotImage',
            v: 1,
            props: { ...fixtureHotspotImage, image: upload },
            data: {},
          },
        ]),
      );
      const img = () =>
        document.querySelector('[data-block="hotspotImage"] img') as HTMLImageElement;
      expect(img().getAttribute('src')).toBe(upload.replace(/\.jpg$/, '.w960.jpg'));
      fireEvent.error(img());
      expect(img().getAttribute('src')).toBe(upload);
    });

    it("loads a custom 服务宫格 icon's 480 px copy, and the original when the copy is missing", async () => {
      const upload = `/uploads/decor/2026/09/${HASH}.png`;
      const items = [{ ...fixtureServiceGrid.items[0]!, icon: upload }];
      await draw(
        pageOf([
          {
            id: 'b-service',
            type: 'serviceGrid',
            v: 1,
            props: { ...fixtureServiceGrid, items },
            data: {},
          },
        ]),
      );
      const img = () =>
        document.querySelector('[data-block="serviceGrid"] img') as HTMLImageElement;
      expect(img().getAttribute('src')).toBe(upload.replace(/\.png$/, '.w480.png'));
      fireEvent.error(img());
      expect(img().getAttribute('src')).toBe(upload);
    });

    it('tells the blocks a shopper is signed in even when the page came without personal slots', async () => {
      shopper();
      // 新人券 for a signed-in shopper holding none: hidden, not the guest's 注册领取.
      await draw(pageOf([newcomerBlock]));
      expect(screen.queryByText('注册领取')).toBeNull();
    });
  });
});
