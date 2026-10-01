import { fireEvent, screen } from '@testing-library/dom';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_NOW,
  fixtureArticleList,
  fixtureArticles,
  fixtureCouponList,
  fixtureCoupons,
  fixtureFloatingContact,
  fixtureFollowOfficialAccount,
  fixtureGroupbuyList,
  fixtureGroupbuys,
  fixtureNewcomerCoupon,
  fixtureNewUserCoupons,
  fixturePersonalG2,
  fixturePresaleList,
  fixturePresales,
  fixtureServerNow,
  fixtureVideo,
} from '../fixtures';
import { act, cleanup, render } from '../test/render';
import {
  ArticleList,
  BlockList,
  CouponList,
  couponAction,
  couponValidity,
  FloatingContact,
  FollowOfficialAccount,
  GroupbuyList,
  NewcomerCoupon,
  PresaleList,
  presaleCountdown,
  Video,
} from './index';
import { formatRemaining } from './shared/time';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * The batch-2 blocks (优惠券, 新人券, 拼团, 预售, 资讯, 视频, 悬浮客服,
 * 关注公众号), through the DOM shim, on React 19 and React 18. They call no
 * API: taps become links or intents, and the per-shopper state arrives as
 * `personal` (DECOR-015).
 */

const route = (to: string, params: Record<string, string> = {}) => ({
  kind: 'route',
  to: { route: to, params },
});

describe('CouponList', () => {
  it('draws each coupon’s amount, threshold and validity, and asks to claim on 领取', () => {
    const onIntent = vi.fn();
    const onLink = vi.fn();
    const { container } = render(
      <CouponList
        props={fixtureCouponList}
        data={{ coupons: fixtureCoupons }}
        onIntent={onIntent}
        onLink={onLink}
      />,
    );
    expect(container.querySelectorAll('[data-coupon]')).toHaveLength(3);
    expect(screen.getByText('满99可用')).toBeTruthy();
    expect(screen.getByText('无门槛')).toBeTruthy();
    expect(screen.getByText('领取后 7 天内有效')).toBeTruthy();
    expect(screen.getByText('06.01-06.30 有效')).toBeTruthy();
    // A guest: every coupon offers 领取, and the host decides about signing in.
    expect(screen.getAllByText('领取')).toHaveLength(3);
    fireEvent.click(container.querySelector('[data-coupon="22"]') as Element);
    expect(onIntent).toHaveBeenCalledWith({ kind: 'claimCoupon', templateId: '22' });
    fireEvent.click(screen.getByText('更多'));
    expect(onLink).toHaveBeenCalledWith(route('couponCenter'));
  });

  it('shows each coupon as the shopper stands with it', () => {
    const onIntent = vi.fn();
    const onLink = vi.fn();
    const { container } = render(
      <CouponList
        props={{ ...fixtureCouponList, layout: 'stack' }}
        data={{ coupons: fixtureCoupons }}
        personal={fixturePersonalG2.couponList}
        onIntent={onIntent}
        onLink={onLink}
      />,
    );
    const actionOf = (id: string) =>
      container.querySelector(`[data-coupon="${id}"]`)?.getAttribute('data-action');
    expect([actionOf('21'), actionOf('22'), actionOf('23')]).toEqual(['use', 'again', 'claim']);
    expect(screen.getByText('去使用')).toBeTruthy();
    expect(screen.getByText('再领一张')).toBeTruthy();
    fireEvent.click(container.querySelector('[data-coupon="21"]') as Element);
    expect(onLink).toHaveBeenCalledWith(route('myCoupons'));
    expect(onIntent).not.toHaveBeenCalled();
  });

  it('maps claim state to the button, and says nothing it cannot back', () => {
    expect(couponAction(undefined)).toBe('claim');
    expect(couponAction({ templateId: '1', claimedCount: 0, canClaim: true })).toBe('claim');
    expect(couponAction({ templateId: '1', claimedCount: 2, canClaim: true })).toBe('again');
    expect(couponAction({ templateId: '1', claimedCount: 1, canClaim: false })).toBe('use');
    expect(couponAction({ templateId: '1', claimedCount: 0, canClaim: false })).toBe('gone');
    expect(couponValidity({ ...fixtureCoupons[1]!, validFrom: null })).toBe('06.30 前有效');
  });

  it('hides itself with nothing to claim, but says so in the editor', () => {
    const { container } = render(<CouponList props={fixtureCouponList} data={{ coupons: [] }} />);
    expect(container.innerHTML).toBe('');
    render(<CouponList props={fixtureCouponList} host={{ canvas: true }} />);
    expect(screen.getByText(/暂无可领取的优惠券/)).toBeTruthy();
  });

  it('has no 「更多」 when turned off, and no heading without a title', () => {
    const { container } = render(
      <CouponList
        props={{ ...fixtureCouponList, title: '', showMore: false }}
        data={{ coupons: fixtureCoupons }}
      />,
    );
    expect(screen.queryByText('更多')).toBeNull();
    expect(screen.queryByText('领券中心')).toBeNull();
    expect(container.querySelectorAll('[data-coupon]')).toHaveLength(3);
  });
});

describe('NewcomerCoupon', () => {
  it('offers a guest the 新人券 and asks the host to register them', () => {
    const onIntent = vi.fn();
    render(
      <NewcomerCoupon
        props={fixtureNewcomerCoupon}
        data={{ coupons: fixtureNewUserCoupons }}
        onIntent={onIntent}
        host={{ signedIn: false }}
      />,
    );
    expect(screen.getByText('新人专享')).toBeTruthy();
    expect(screen.getByText('满129可用')).toBeTruthy();
    fireEvent.click(screen.getByText('注册领取'));
    expect(onIntent).toHaveBeenCalledWith({ kind: 'claimNewcomerCoupons' });
  });

  it('tells a signed-in shopper the 新人券 they hold, with 去使用', () => {
    const onLink = vi.fn();
    const onIntent = vi.fn();
    render(
      <NewcomerCoupon
        props={fixtureNewcomerCoupon}
        data={{ coupons: fixtureNewUserCoupons }}
        personal={fixturePersonalG2.newcomerCoupon}
        onLink={onLink}
        onIntent={onIntent}
        host={{ signedIn: true }}
      />,
    );
    expect(screen.getByText('新人券已到账')).toBeTruthy();
    expect(screen.getByText('06.07 到期')).toBeTruthy();
    expect(screen.queryByText('注册领取')).toBeNull();
    fireEvent.click(screen.getByText('去使用'));
    expect(onLink).toHaveBeenCalledWith(route('myCoupons'));
    expect(onIntent).not.toHaveBeenCalled();
  });

  it('is hidden from a signed-in shopper holding none, or whose lookup failed', () => {
    const empty = render(
      <NewcomerCoupon
        props={fixtureNewcomerCoupon}
        data={{ coupons: fixtureNewUserCoupons }}
        personal={{ held: { kind: 'newcomerCoupons', coupons: [] } }}
        host={{ signedIn: true }}
      />,
    );
    expect(empty.container.innerHTML).toBe('');
    const failed = render(
      <NewcomerCoupon
        props={fixtureNewcomerCoupon}
        data={{ coupons: fixtureNewUserCoupons }}
        host={{ signedIn: true }}
      />,
    );
    expect(failed.container.innerHTML).toBe('');
  });

  it('is hidden from a guest when no 新人券 is on offer', () => {
    const { container } = render(
      <NewcomerCoupon props={fixtureNewcomerCoupon} data={{ coupons: [] }} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('GroupbuyList', () => {
  it('shows the 拼团价, team size and sales, and opens the campaign', () => {
    const onLink = vi.fn();
    render(
      <GroupbuyList
        props={fixtureGroupbuyList}
        data={{ campaigns: fixtureGroupbuys }}
        onLink={onLink}
      />,
    );
    expect(screen.getByText('2人团')).toBeTruthy();
    expect(screen.getByText('3人团')).toBeTruthy();
    expect(screen.getByText('已拼 36 件')).toBeTruthy();
    expect(screen.getByText('¥129.90')).toBeTruthy();
    fireEvent.click(screen.getByText('厨房收纳三件套'));
    expect(onLink).toHaveBeenCalledWith(route('groupbuy', { id: '42' }));
    fireEvent.click(screen.getByText('更多'));
    expect(onLink).toHaveBeenLastCalledWith(route('groupbuyList'));
  });

  it('lays the cards out sideways, and hides itself with nothing running', () => {
    const { container } = render(
      <GroupbuyList
        props={{ ...fixtureGroupbuyList, layout: 'scroll' }}
        data={{ campaigns: fixtureGroupbuys }}
      />,
    );
    expect(container.querySelectorAll('[data-campaign]')).toHaveLength(2);
    expect(container.querySelector('.sbd-scroll')).not.toBeNull();
    const empty = render(<GroupbuyList props={fixtureGroupbuyList} data={{ campaigns: [] }} />);
    expect(empty.container.innerHTML).toBe('');
  });
});

describe('PresaleList', () => {
  it('shows the 预售价, the struck price and when it ships, and opens the campaign', () => {
    const onLink = vi.fn();
    render(
      <PresaleList
        props={fixturePresaleList}
        data={{ campaigns: fixturePresales }}
        onLink={onLink}
        host={{ serverNow: fixtureServerNow }}
      />,
    );
    expect(screen.getAllByText('预售价')).toHaveLength(2);
    expect(screen.getByText('¥299.00')).toBeTruthy();
    expect(screen.getByText('付款后 15 天内发货')).toBeTruthy();
    expect(screen.getByText('付款后尽快发货')).toBeTruthy();
    expect(screen.queryByText(/定金|尾款/)).toBeNull();
    fireEvent.click(screen.getByText('主动降噪真无线蓝牙耳机 长续航'));
    expect(onLink).toHaveBeenCalledWith(route('presale', { id: '51' }));
  });

  it('counts down on the server’s clock, one tick a second, and ends at 已结束', () => {
    vi.useFakeTimers();
    let now = FIXTURE_NOW;
    const serverNow = () => now;
    const { container } = render(
      <PresaleList
        props={fixturePresaleList}
        data={{ campaigns: fixturePresales }}
        host={{ serverNow }}
      />,
    );
    const shown = (id: string) =>
      container.querySelector(`[data-countdown="${id}"]`)?.textContent ?? '';
    expect(shown('51')).toBe('距结束 2天 03:04:05');
    expect(shown('52')).toBe('距结束 01:30:00');
    now += 5_000;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(shown('51')).toBe('距结束 2天 03:04:00');
    now = Date.parse(fixturePresales[1]!.endAt);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(shown('52')).toBe('已结束');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops ticking while its page is hidden, and catches up when shown', () => {
    vi.useFakeTimers();
    let now = FIXTURE_NOW;
    const serverNow = () => now;
    const block = (hidden: boolean) => (
      <PresaleList
        props={fixturePresaleList}
        data={{ campaigns: fixturePresales }}
        host={{ serverNow, hidden }}
      />
    );
    const { container, rerender } = render(block(false));
    const shown = () => container.querySelector('[data-countdown="51"]')?.textContent ?? '';
    expect(vi.getTimerCount()).toBe(1);

    rerender(block(true));
    expect(vi.getTimerCount()).toBe(0);
    now += 60_000;
    rerender(block(false));
    expect(shown()).toBe('距结束 2天 03:03:05');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('never reads the device clock: without serverNow it shows the end time instead', () => {
    const spy = vi.spyOn(Date, 'now');
    const { container } = render(
      <PresaleList props={fixturePresaleList} data={{ campaigns: fixturePresales }} />,
    );
    expect(container.querySelector('[data-countdown="51"]')?.textContent).toBe(
      '06月03日 15:04 结束',
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('shows the phase before the window opens, and no countdown when turned off', () => {
    const campaign = { startAt: '2026-06-02T00:00:00.000Z', endAt: '2026-06-05T00:00:00.000Z' };
    expect(presaleCountdown(campaign, Date.parse('2026-06-01T23:00:00.000Z'))).toBe(
      '距开始 01:00:00',
    );
    expect(formatRemaining(-5)).toBe('00:00:00');
    const { container } = render(
      <PresaleList
        props={{ ...fixturePresaleList, showCountdown: false }}
        data={{ campaigns: fixturePresales }}
        host={{ serverNow: fixtureServerNow }}
      />,
    );
    expect(container.querySelector('[data-countdown]')).toBeNull();
  });
});

describe('ArticleList', () => {
  it('lists articles with category and date, opening the article', () => {
    const onLink = vi.fn();
    const { container } = render(
      <ArticleList
        props={fixtureArticleList}
        data={{ articles: fixtureArticles }}
        onLink={onLink}
      />,
    );
    expect(screen.getByText('生活指南 · 2026-05-28')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(1);
    fireEvent.click(screen.getByText('门店营业时间调整通知'));
    expect(onLink).toHaveBeenCalledWith({ kind: 'article', id: '62' });
    fireEvent.click(screen.getByText('更多'));
    expect(onLink).toHaveBeenLastCalledWith(route('articleList'));
  });

  it('draws the card style with the summary, and 「更多」 keeps the category', () => {
    const onLink = vi.fn();
    render(
      <ArticleList
        props={{
          ...fixtureArticleList,
          layout: 'card',
          source: { mode: 'category', categoryId: '5', limit: 3 },
        }}
        data={{ articles: fixtureArticles }}
        onLink={onLink}
      />,
    );
    expect(screen.getByText('从面料成分到洗涤方式，一篇讲清楚。')).toBeTruthy();
    fireEvent.click(screen.getByText('更多'));
    expect(onLink).toHaveBeenCalledWith(route('articleList', { categoryId: '5' }));
  });
});

describe('Video', () => {
  it('plays through the native player, autoplay off and unmuted by default', () => {
    const { container } = render(<Video props={fixtureVideo} />);
    const video = container.querySelector('video');
    expect(video?.getAttribute('src')).toBe('/fixtures/intro.mp4');
    expect(video?.hasAttribute('autoplay')).toBe(false);
    expect(video?.muted).toBe(false);
  });

  it('autoplays muted when the operator asks for both', () => {
    const { container } = render(
      <Video props={{ ...fixtureVideo, autoplay: true, muted: true }} />,
    );
    const video = container.querySelector('video');
    expect(video?.autoplay).toBe(true);
    expect(video?.muted).toBe(true);
  });

  it('unmounts the player under an overlay and in the editor, showing the poster', () => {
    const { container, rerender } = render(<Video props={fixtureVideo} />);
    rerender(<Video props={fixtureVideo} host={{ overlayOpen: true }} />);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('[data-still]')).not.toBeNull();
    rerender(<Video props={fixtureVideo} host={{ overlayOpen: false }} />);
    expect(container.querySelector('video')).not.toBeNull();
    rerender(<Video props={fixtureVideo} host={{ canvas: true }} />);
    expect(container.querySelector('video')).toBeNull();
  });

  it('resolves the video and poster URLs through the host, never asking for a copy', () => {
    const resolveImage = vi.fn((src: string, width?: number) =>
      width ? `https://api.test${src}@${width}` : `https://api.test${src}`,
    );
    const props = { ...fixtureVideo, src: '/uploads/intro.mp4', poster: '/uploads/poster.jpg' };
    const { container } = render(<Video props={props} host={{ resolveImage }} />);
    const video = container.querySelector('video');
    expect(video?.getAttribute('src')).toBe('https://api.test/uploads/intro.mp4');
    expect(video?.getAttribute('poster')).toBe('https://api.test/uploads/poster.jpg');
    expect(resolveImage.mock.calls.every(([, width]) => width === undefined)).toBe(true);
  });
});

describe('FloatingContact', () => {
  it('floats a contact button that asks for the contact intent', () => {
    const onIntent = vi.fn();
    const { container } = render(
      <FloatingContact props={fixtureFloatingContact} onIntent={onIntent} />,
    );
    const button = container.querySelector('[data-intent="contact"]') as HTMLElement;
    expect(button.style.getPropertyValue('--sb-bottom')).toBe('240');
    fireEvent.click(button);
    expect(onIntent).toHaveBeenCalledWith({ kind: 'contact' });
  });

  it('lets the host draw the native control, or nothing when the shop has no 客服', () => {
    const onIntent = vi.fn();
    const wrapped = render(
      <FloatingContact
        props={fixtureFloatingContact}
        onIntent={onIntent}
        renderIntent={(intent, children: ReactNode) => (
          <button type="button" data-host-intent={intent.kind}>
            {children}
          </button>
        )}
      />,
    );
    const button = wrapped.container.querySelector('[data-host-intent="contact"]');
    expect(button?.textContent).toBe('客服');
    fireEvent.click(button as Element);
    expect(onIntent).not.toHaveBeenCalled();

    const none = render(
      <FloatingContact props={fixtureFloatingContact} renderIntent={() => null} />,
    );
    expect(none.container.innerHTML).toBe('');
  });

  it('sits in the flow in the editor, saying where it will float', () => {
    render(
      <FloatingContact
        props={{ ...fixtureFloatingContact, side: 'left' }}
        host={{ canvas: true }}
      />,
    );
    expect(screen.getByText('悬浮在页面左侧，距底部 240')).toBeTruthy();
  });
});

describe('FollowOfficialAccount', () => {
  it('renders what the host gives for the officialAccount intent, and nothing otherwise', () => {
    const renderIntent = vi.fn((intent: { kind: string }) => (
      <div data-native={intent.kind}>official-account</div>
    ));
    const { container } = render(
      <FollowOfficialAccount props={fixtureFollowOfficialAccount} renderIntent={renderIntent} />,
    );
    expect(container.querySelector('[data-native="officialAccount"]')).not.toBeNull();
    expect(renderIntent).toHaveBeenCalledWith({ kind: 'officialAccount' }, null);

    const bare = render(<FollowOfficialAccount props={fixtureFollowOfficialAccount} />);
    expect(bare.container.innerHTML).toBe('');
    const refused = render(
      <FollowOfficialAccount props={fixtureFollowOfficialAccount} renderIntent={() => null} />,
    );
    expect(refused.container.innerHTML).toBe('');
  });

  it('explains itself in the editor', () => {
    render(<FollowOfficialAccount props={fixtureFollowOfficialAccount} host={{ canvas: true }} />);
    expect(screen.getByText(/从扫码（二维码 \/ 小程序码）进入时出现/)).toBeTruthy();
  });
});

describe('BlockList with the batch-2 blocks', () => {
  it('tells the blocks whether a shopper is signed in, from personal', () => {
    const blocks = [
      { id: 'n', type: 'newcomerCoupon', props: fixtureNewcomerCoupon },
      { id: 'c', type: 'couponList', props: fixtureCouponList },
    ];
    const data = { n: { coupons: fixtureNewUserCoupons }, c: { coupons: fixtureCoupons } };
    const guest = render(<BlockList blocks={blocks} data={data} personal={null} />);
    expect(guest.container.textContent).toContain('注册领取');
    guest.unmount();

    const shopper = render(
      <BlockList
        blocks={blocks}
        data={data}
        personal={{ n: fixturePersonalG2.newcomerCoupon, c: fixturePersonalG2.couponList }}
      />,
    );
    expect(shopper.container.textContent).toContain('新人券已到账');
    expect(shopper.container.textContent).toContain('再领一张');
    shopper.unmount();

    // Signed in, but the 新人券 lookup failed: hidden, never the guest offer.
    const failed = render(<BlockList blocks={blocks} data={data} personal={{}} />);
    expect(failed.container.textContent).not.toContain('注册领取');
    expect(failed.container.textContent).not.toContain('新人券已到账');
  });

  it('passes the host through: the clock to 预售, canvas to the stand-ins', () => {
    const { container } = render(
      <BlockList
        blocks={[
          { id: 'p', type: 'presaleList', props: fixturePresaleList },
          { id: 'f', type: 'floatingContact', props: fixtureFloatingContact },
        ]}
        data={{ p: { campaigns: fixturePresales } }}
        host={{ serverNow: fixtureServerNow, canvas: true }}
      />,
    );
    expect(container.querySelector('[data-countdown="51"]')?.textContent).toBe(
      '距结束 2天 03:04:05',
    );
    expect(container.textContent).toContain('悬浮在页面右侧');
  });
});
