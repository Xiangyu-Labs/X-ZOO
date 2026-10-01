import { fireEvent, screen } from '@testing-library/dom';
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fixtureCarousel,
  fixtureOrderEntry,
  fixturePersonal,
  fixtureServiceGrid,
  fixtureUserCard,
} from '../fixtures';
import { cleanup, render } from '../test/render';
import { BlockList, OrderEntry, orderEntryLink, ServiceGrid, UserCard } from './index';
import orderStyles from './order-entry/order-entry.module.scss';

afterEach(cleanup);

/**
 * The 个人中心 blocks, through the DOM shim, on React 19 and React 18. Their
 * per-shopper state arrives as `personal` (DECOR-015); a guest has none.
 */

/** A host resolver that shows what it was asked for. */
const resolveImage = (src: string, width?: 480 | 960) =>
  width ? `https://api.test${src}@${width}` : `https://api.test${src}`;
const sources = (container: Element) =>
  [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));

const route = (to: string, params: Record<string, string> = {}) => ({
  kind: 'route',
  to: { route: to, params },
});

describe('UserCard', () => {
  it('shows the signed-in shopper and their totals, each linking to its page', () => {
    const onLink = vi.fn();
    render(
      <UserCard props={fixtureUserCard} personal={fixturePersonal.userCard} onLink={onLink} />,
    );
    expect(screen.getByText('小林')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('28')).toBeTruthy();
    fireEvent.click(screen.getByText('小林'));
    expect(onLink).toHaveBeenLastCalledWith(route('profile'));
    fireEvent.click(screen.getByText('足迹'));
    expect(onLink).toHaveBeenLastCalledWith(route('history'));
  });

  it('loads a stored avatar through the host', () => {
    const personal = {
      kind: 'userSummary' as const,
      user: { nickname: '小林', avatarUrl: '/uploads/avatar/1.png', stats: null },
    };
    const { container } = render(
      <UserCard
        props={fixtureUserCard}
        personal={{ user: personal }}
        host={{ resolveImage: (src) => `https://shop.example${src}` }}
      />,
    );
    const srcs = Array.from(container.querySelectorAll('img')).map((img) =>
      img.getAttribute('src'),
    );
    expect(srcs).toContain('https://shop.example/uploads/avatar/1.png');
  });

  it('asks a guest to sign in, through the login intent, with no numbers', () => {
    const onIntent = vi.fn();
    const onLink = vi.fn();
    render(<UserCard props={fixtureUserCard} onIntent={onIntent} onLink={onLink} />);
    expect(screen.getAllByText('-')).toHaveLength(3);
    fireEvent.click(screen.getByText('登录 / 注册'));
    expect(onIntent).toHaveBeenCalledWith({ kind: 'login' });
    expect(onLink).not.toHaveBeenCalled();
  });

  it('names a shopper without a nickname, and hides the totals when turned off', () => {
    render(
      <UserCard
        props={{ ...fixtureUserCard, showStats: false }}
        personal={{
          user: { kind: 'userSummary', user: { nickname: null, avatarUrl: null, stats: null } },
        }}
      />,
    );
    expect(screen.getByText('微信用户')).toBeTruthy();
    expect(screen.queryByText('优惠券')).toBeNull();
  });

  it('asks, in small print, for a nickname and avatar only while they are the sign-up ones', () => {
    const onLink = vi.fn();
    const card = (profileIncomplete?: boolean) => (
      <UserCard
        props={fixtureUserCard}
        onLink={onLink}
        personal={{
          user: {
            kind: 'userSummary',
            user: {
              nickname: '用户8000',
              avatarUrl: null,
              stats: null,
              ...(profileIncomplete === undefined ? {} : { profileIncomplete }),
            },
          },
        }}
      />
    );
    const { rerender } = render(card(true));
    fireEvent.click(screen.getByText('点击设置头像和昵称'));
    expect(onLink).toHaveBeenLastCalledWith(route('profile'));
    rerender(card(false));
    expect(screen.queryByText('点击设置头像和昵称')).toBeNull();
    rerender(card());
    expect(screen.queryByText('点击设置头像和昵称')).toBeNull();
  });

  it('keeps the sign-in prompt, not the profile line, for a guest', () => {
    render(<UserCard props={fixtureUserCard} />);
    expect(screen.getByText('登录后查看订单和优惠券')).toBeTruthy();
    expect(screen.queryByText('点击设置头像和昵称')).toBeNull();
  });
});

describe('OrderEntry', () => {
  it('badges each status with the shopper’s count: none for 0, 99+ past 99', () => {
    const { container } = render(
      <OrderEntry props={fixtureOrderEntry} personal={fixturePersonal.orderEntry} />,
    );
    const badges = [...container.querySelectorAll(`.${orderStyles.badge as string}`)].map(
      (badge) => badge.textContent,
    );
    // unpaid 1, unshipped 2, unreceived 0, unreviewed (not counted), aftersale 120.
    expect(badges).toEqual(['1', '2', '99+']);
  });

  it('shows no badge to a guest', () => {
    const { container } = render(<OrderEntry props={fixtureOrderEntry} />);
    expect(container.querySelector(`.${orderStyles.badge as string}`)).toBeNull();
    expect(screen.getByText('待付款')).toBeTruthy();
  });

  it('opens the order list on the entry’s tab, and 全部订单 on none', () => {
    const onLink = vi.fn();
    render(<OrderEntry props={fixtureOrderEntry} onLink={onLink} />);
    fireEvent.click(screen.getByText('待发货'));
    expect(onLink).toHaveBeenLastCalledWith(route('orderList', { tab: 'unshipped' }));
    fireEvent.click(screen.getByText('售后/退款'));
    expect(onLink).toHaveBeenLastCalledWith(route('refundList'));
    fireEvent.click(screen.getByText('全部订单'));
    expect(onLink).toHaveBeenLastCalledWith(route('orderList'));
    expect(orderEntryLink('unreviewed')).toEqual(route('orderList', { tab: 'unreviewed' }));
  });

  it('loads a custom icon through the host (its 480 px copy), the built-in ones as they are', () => {
    const items = fixtureOrderEntry.items.map((item, n) =>
      n === 0 ? { ...item, icon: '/uploads/unpaid.png' } : item,
    );
    const { container } = render(
      <OrderEntry props={{ ...fixtureOrderEntry, items }} host={{ resolveImage }} />,
    );
    const [custom, ...builtIn] = sources(container);
    expect(custom).toBe('https://api.test/uploads/unpaid.png@480');
    expect(builtIn).toHaveLength(4);
    for (const src of builtIn) expect(src).toMatch(/^data:image\/svg\+xml/);

    act(() => {
      fireEvent.error(container.querySelector('img') as Element);
    });
    expect(sources(container)[0]).toBe('https://api.test/uploads/unpaid.png');
  });

  it('loads a custom icon as stored without a resolver (the editor canvas)', () => {
    const items = [{ ...fixtureOrderEntry.items[0]!, icon: '/uploads/unpaid.png' }];
    const { container } = render(<OrderEntry props={{ ...fixtureOrderEntry, items }} />);
    expect(sources(container)).toEqual(['/uploads/unpaid.png']);
  });
});

describe('ServiceGrid', () => {
  it('links a link entry and asks for contact on 联系客服', () => {
    const onLink = vi.fn();
    const onIntent = vi.fn();
    render(<ServiceGrid props={fixtureServiceGrid} onLink={onLink} onIntent={onIntent} />);
    fireEvent.click(screen.getByText('收货地址'));
    expect(onLink).toHaveBeenCalledWith(route('addresses'));
    fireEvent.click(screen.getByText('联系客服'));
    expect(onIntent).toHaveBeenCalledWith({ kind: 'contact' });
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it('lets the host wrap the contact entry in its own control, and then adds no tap', () => {
    const onIntent = vi.fn();
    const renderIntent = vi.fn((intent: { kind: string }, children: ReactNode) => (
      <button type="button" data-host-intent={intent.kind}>
        {children}
      </button>
    ));
    const { container } = render(
      <ServiceGrid props={fixtureServiceGrid} onIntent={onIntent} renderIntent={renderIntent} />,
    );
    const button = container.querySelector('[data-intent="contact"] button');
    expect(button?.getAttribute('data-host-intent')).toBe('contact');
    expect(button?.textContent).toContain('联系客服');
    fireEvent.click(button as Element);
    expect(onIntent).not.toHaveBeenCalled();
    expect(renderIntent).toHaveBeenCalledTimes(1);
  });

  it('draws the label’s first character when an entry has no icon', () => {
    render(<ServiceGrid props={fixtureServiceGrid} />);
    expect(screen.getByText('联')).toBeTruthy();
  });

  it('loads a custom icon through the host (its 480 px copy), the original when that fails', () => {
    const items = fixtureServiceGrid.items.map((item, n) =>
      n === 0 ? { ...item, icon: '/uploads/coupon.png' } : item,
    );
    const { container } = render(
      <ServiceGrid props={{ ...fixtureServiceGrid, items }} host={{ resolveImage }} />,
    );
    expect(sources(container)).toEqual(['https://api.test/uploads/coupon.png@480']);
    act(() => {
      fireEvent.error(container.querySelector('img') as Element);
    });
    expect(sources(container)).toEqual(['https://api.test/uploads/coupon.png']);
  });

  it('loads a custom icon as stored without a resolver (the editor canvas)', () => {
    const items = [{ ...fixtureServiceGrid.items[0]!, icon: '/uploads/coupon.png' }];
    const { container } = render(<ServiceGrid props={{ ...fixtureServiceGrid, items }} />);
    expect(sources(container)).toEqual(['/uploads/coupon.png']);
  });
});

describe('BlockList with per-shopper state', () => {
  it('hands each block its own personal slots and the intent handlers', () => {
    const onIntent = vi.fn();
    const { container } = render(
      <BlockList
        blocks={[
          { id: 'u', type: 'userCard', props: fixtureUserCard },
          { id: 'o', type: 'orderEntry', props: fixtureOrderEntry },
          { id: 's', type: 'serviceGrid', props: fixtureServiceGrid },
          { id: 'c', type: 'carousel', props: fixtureCarousel },
        ]}
        personal={{ u: fixturePersonal.userCard, o: fixturePersonal.orderEntry }}
        onIntent={onIntent}
      />,
    );
    expect(screen.getByText('小林')).toBeTruthy();
    expect(container.querySelectorAll(`.${orderStyles.badge as string}`)).toHaveLength(3);
    fireEvent.click(screen.getByText('联系客服'));
    expect(onIntent).toHaveBeenCalledWith({ kind: 'contact' });
  });

  it('renders a guest page with no personal state at all', () => {
    render(
      <BlockList
        blocks={[{ id: 'u', type: 'userCard', props: fixtureUserCard }]}
        personal={null}
      />,
    );
    expect(screen.getByText('登录 / 注册')).toBeTruthy();
  });
});
