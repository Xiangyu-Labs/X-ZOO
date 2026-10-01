import { fireEvent, screen } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fixtureHotspotImage,
  fixtureNavGrid,
  fixtureNotice,
  fixtureProductGrid,
  fixtureProducts,
  fixtureProductTabs,
  fixtureProductTabsData,
  fixtureRichText,
  fixtureSearchBar,
  fixtureSpacer,
  fixtureTitleBar,
} from '../fixtures';
import { act, cleanup, render } from '../test/render';
import hotspotStyles from './hotspot-image/hotspot-image.module.scss';
import {
  HotspotImage,
  NavGrid,
  Notice,
  ProductGrid,
  ProductTabs,
  RichText,
  SearchBar,
  Spacer,
  TitleBar,
} from './index';
import navStyles from './nav-grid/nav-grid.module.scss';
import cardStyles from './product-grid/product-cards.module.scss';
import tabStyles from './product-tabs/product-tabs.module.scss';
import searchStyles from './search-bar/search-bar.module.scss';
import spacerStyles from './spacer/spacer.module.scss';
import titleStyles from './title-bar/title-bar.module.scss';

afterEach(cleanup);

/**
 * The batch-1 content blocks, through the DOM shim. Like `blocks.test.tsx`,
 * this file runs on React 19 (`unit`) and React 18 (`unit-react18`).
 */

const cls = (name: string | undefined) => `.${name ?? 'missing-class'}`;

describe('SearchBar', () => {
  it('opens the search page, and a hot word opens it with that keyword', () => {
    const onLink = vi.fn();
    render(<SearchBar props={fixtureSearchBar} onLink={onLink} />);
    fireEvent.click(screen.getByLabelText('搜索'));
    expect(onLink).toHaveBeenLastCalledWith({ kind: 'route', to: { route: 'search', params: {} } });
    fireEvent.click(screen.getByText('礼盒'));
    expect(onLink).toHaveBeenLastCalledWith({
      kind: 'route',
      to: { route: 'search', params: { keyword: '礼盒' } },
    });
  });

  it('shows the placeholder, and no hot-word row without hot words', () => {
    const { container } = render(
      <SearchBar props={{ ...fixtureSearchBar, placeholder: '找好物', hotWords: [] }} />,
    );
    expect(screen.getByText('找好物')).toBeTruthy();
    expect(container.querySelector('.sbd-scroll')).toBeNull();
  });

  it('sticks to the top only when asked', () => {
    const plain = render(<SearchBar props={fixtureSearchBar} />);
    expect(plain.container.querySelector(cls(searchStyles.sticky))).toBeNull();
    plain.unmount();
    const sticky = render(<SearchBar props={{ ...fixtureSearchBar, sticky: true }} />);
    const outer = sticky.container.querySelector('[data-block="searchBar"]');
    expect(outer?.classList.contains(searchStyles.sticky as string)).toBe(true);
  });
});

describe('NavGrid', () => {
  it('draws every entry on one grid without paging, and links each one', () => {
    const onLink = vi.fn();
    const { container } = render(<NavGrid props={fixtureNavGrid} onLink={onLink} />);
    expect(container.querySelectorAll(cls(navStyles.cell))).toHaveLength(10);
    expect(container.querySelector('.sbd-swiper')).toBeNull();
    fireEvent.click(screen.getByText('礼物'));
    expect(onLink).toHaveBeenCalledWith({ kind: 'category', id: '5' });
  });

  it('pages by columns × rows, with a dot per page', () => {
    const { container } = render(
      <NavGrid props={{ ...fixtureNavGrid, paging: true, rows: 1, columns: 4 }} />,
    );
    // 10 entries, 4 to a page → 3 pages.
    expect(container.querySelectorAll('.sbd-swiper-item')).toHaveLength(3);
    const dots = container.querySelectorAll(cls(navStyles.dot));
    expect(dots).toHaveLength(3);
    expect(dots[0]?.classList.contains(navStyles.dotActive as string)).toBe(true);
  });

  it('does not page what fits on one page', () => {
    const { container } = render(<NavGrid props={{ ...fixtureNavGrid, paging: true }} />);
    expect(container.querySelector('.sbd-swiper')).toBeNull();
  });
});

describe('Notice', () => {
  it('lists every line when static and links the ones that link', () => {
    const onLink = vi.fn();
    render(<Notice props={fixtureNotice} onLink={onLink} />);
    expect(screen.getByText('公告')).toBeTruthy();
    fireEvent.click(screen.getByText('全场满 199 元包邮，隐私包装发货'));
    expect(onLink).toHaveBeenCalledWith({
      kind: 'route',
      to: { route: 'couponCenter', params: {} },
    });
    fireEvent.click(screen.getByText('国庆假期正常发货'));
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it('rolls the lines vertically at the chosen pace when scrolling', () => {
    const { container } = render(
      <Notice props={{ ...fixtureNotice, mode: 'scroll', interval: 6000 }} />,
    );
    expect(container.querySelector('.sbd-swiper__track--vertical')).not.toBeNull();
    expect(container.querySelectorAll('.sbd-swiper-item')).toHaveLength(2);
  });

  it('does not roll a single line', () => {
    const { container } = render(
      <Notice
        props={{ ...fixtureNotice, mode: 'scroll', lines: fixtureNotice.lines.slice(0, 1) }}
      />,
    );
    expect(container.querySelector('.sbd-swiper')).toBeNull();
  });
});

describe('HotspotImage', () => {
  it('lays each spot over the picture in percent and links it', () => {
    const onLink = vi.fn();
    const { container } = render(<HotspotImage props={fixtureHotspotImage} onLink={onLink} />);
    expect(container.querySelector('.sbd-image--widthFix')).not.toBeNull();
    const spots = container.querySelectorAll<HTMLElement>(cls(hotspotStyles.spot));
    expect(spots).toHaveLength(2);
    expect(spots[1]?.style.left).toBe('58%');
    expect(spots[1]?.style.width).toBe('33.3%');
    expect(spots[1]?.getAttribute('aria-label')).toBe('右侧活动');
    fireEvent.click(spots[1] as Element);
    expect(onLink).toHaveBeenCalledWith({ kind: 'category', id: '3' });
  });
});

describe('TitleBar', () => {
  it('shows title and subtitle, and 更多 links where it points', () => {
    const onLink = vi.fn();
    render(<TitleBar props={fixtureTitleBar} onLink={onLink} />);
    expect(screen.getByText('热卖推荐')).toBeTruthy();
    expect(screen.getByText('大家都在买')).toBeTruthy();
    fireEvent.click(screen.getByText('更多'));
    expect(onLink).toHaveBeenCalledWith({ kind: 'category', id: '3' });
  });

  it('has no 更多 without a link, and centres on request', () => {
    const { container } = render(
      <TitleBar props={{ ...fixtureTitleBar, moreLink: undefined, align: 'center' }} />,
    );
    expect(screen.queryByText('更多')).toBeNull();
    expect(container.querySelector(cls(titleStyles.center))).not.toBeNull();
  });
});

describe('Spacer', () => {
  it('is blank space of the given height with no rule by default', () => {
    const { container } = render(<Spacer props={{ ...fixtureSpacer, line: 'none' }} />);
    const space = container.querySelector<HTMLElement>(cls(spacerStyles.space));
    expect(space?.style.getPropertyValue('--sb-height')).toBe('40');
    expect(container.querySelector(cls(spacerStyles.line))).toBeNull();
  });

  it('draws a dashed rule in the chosen colour', () => {
    const { container } = render(
      <Spacer props={{ ...fixtureSpacer, line: 'dashed', lineColor: '#cccccc', inset: false }} />,
    );
    const line = container.querySelector<HTMLElement>(cls(spacerStyles.line));
    expect(line?.classList.contains(spacerStyles.dashed as string)).toBe(true);
    expect(line?.classList.contains(spacerStyles.inset as string)).toBe(false);
    expect(line?.style.borderTopColor).toMatch(/#cccccc|rgb\(204, 204, 204\)/);
  });
});

describe('RichText', () => {
  it('draws the operator’s text from nodes, with each tag’s base style', () => {
    const { container } = render(<RichText props={fixtureRichText} />);
    const root = container.querySelector('.sbd-rich-text');
    expect(root?.querySelector('h3')?.textContent).toBe('购物须知');
    expect(root?.querySelector('strong')?.textContent).toBe('隐私包装');
    expect(root?.querySelectorAll('li')).toHaveLength(2);
    expect(root?.querySelector('h3')?.getAttribute('style')).toMatch(/font-weight:\s*600/);
  });

  it('never renders what the allow-list refuses, even from unsanitised props', () => {
    const { container } = render(
      <RichText
        props={{
          ...fixtureRichText,
          html:
            '<p onclick="alert(1)" style="color:#e1251b;position:fixed">ok</p>' +
            '<script>alert(1)</script><iframe src="https://x.example"></iframe>' +
            '<img src="javascript:alert(1)"><a href="javascript:alert(1)">link</a>',
        }}
      />,
    );
    const root = container.querySelector('.sbd-rich-text') as HTMLElement;
    expect(root.querySelector('script, iframe, img, a')).toBeNull();
    const p = root.querySelector('p') as HTMLElement;
    expect(p.getAttribute('onclick')).toBeNull();
    expect(p.style.position).toBe('');
    expect(p.style.color).toMatch(/#e1251b|rgb\(225, 37, 27\)/);
    expect(root.textContent).toBe('oklink');
  });

  it('loads a site-relative picture through the host, and drops blank paragraphs at the ends', () => {
    const { container } = render(
      <RichText
        props={{
          ...fixtureRichText,
          html:
            '<p></p><p>&nbsp;<br></p><p>正文</p><p><img src="/uploads/a/1.jpg"></p>' +
            '<p></p><p>结尾</p><p><br></p><p> </p>',
        }}
        host={{ resolveImage: (src) => `https://shop.example${src}` }}
      />,
    );
    const root = container.querySelector('.sbd-rich-text') as HTMLElement;
    expect(root.querySelector('img')?.getAttribute('src')).toBe(
      'https://shop.example/uploads/a/1.jpg',
    );
    const paragraphs = Array.from(root.querySelectorAll('p'));
    // The blank one between 图 and 结尾 is the operator's spacing and stays.
    expect(paragraphs.map((p) => p.textContent)).toEqual(['正文', '', '', '结尾']);
  });
});

describe('ProductGrid layouts', () => {
  it('draws each layout the operator can choose', () => {
    for (const layout of ['grid2', 'grid3', 'list', 'scroll'] as const) {
      const { container, unmount } = render(
        <ProductGrid
          props={{ ...fixtureProductGrid, layout }}
          data={{ products: fixtureProducts }}
        />,
      );
      expect(container.querySelectorAll(cls(cardStyles.card)), layout).toHaveLength(
        fixtureProducts.length,
      );
      expect(container.querySelector('.sbd-scroll') !== null, layout).toBe(layout === 'scroll');
      unmount();
    }
  });
});

describe('ProductTabs', () => {
  it('shows the first tab’s products and switches locally on a tap', () => {
    const onLink = vi.fn();
    const { container } = render(
      <ProductTabs props={fixtureProductTabs} data={fixtureProductTabsData} onLink={onLink} />,
    );
    const tabs = container.querySelectorAll(cls(tabStyles.tab));
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.classList.contains(tabStyles.active as string)).toBe(true);
    expect(container.querySelectorAll(cls(cardStyles.card))).toHaveLength(4);

    // 新品 is also a product tag, so the tap goes to the tab element itself;
    // `act` flushes the state update, as React would after a real tap.
    act(() => {
      fireEvent.click(tabs[1] as Element);
    });
    expect(container.querySelectorAll(cls(cardStyles.card))).toHaveLength(2);
    expect(
      container
        .querySelectorAll(cls(tabStyles.tab))[1]
        ?.classList.contains(tabStyles.active as string),
    ).toBe(true);
    // Switching a tab is not a navigation.
    expect(onLink).not.toHaveBeenCalled();
  });

  it('shows an empty tab, or one whose slot failed, as empty', () => {
    render(
      <ProductTabs props={fixtureProductTabs} data={{ ...fixtureProductTabsData, tab0: null }} />,
    );
    expect(screen.getByText('暂无商品')).toBeTruthy();
  });
});
