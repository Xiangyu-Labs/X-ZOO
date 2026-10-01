import { fireEvent, screen } from '@testing-library/dom';
import { act, version } from 'react';
import { version as domVersion } from 'react-dom';
import { afterEach, describe, expect, inject, it, vi } from 'vitest';

import {
  fixtureCarousel,
  fixtureHotspotImage,
  fixtureImageCube,
  fixtureImageCubeRow,
  fixtureProductGrid,
  fixtureProducts,
} from '../fixtures';
import { cleanup, render } from '../test/render';
import { BlockList, Carousel, HotspotImage, ImageCube, ProductGrid } from './index';
import { slidesToLoad } from './carousel/carousel';

afterEach(cleanup);

/**
 * The three spike blocks, rendered through the DOM shim. This file runs twice:
 * once on React 19 (`unit`) and once on React 18 (`unit-react18`).
 */

describe('the React the blocks render with', () => {
  it('is the one this Vitest project is for', () => {
    expect(version.split('.')[0]).toBe(inject('reactMajor'));
    expect(domVersion.split('.')[0]).toBe(inject('reactMajor'));
  });
});

describe('Carousel', () => {
  it('renders a slide per image, fitted aspectFill, with WeChat-style dots', () => {
    const { container } = render(<Carousel props={fixtureCarousel} />);
    const block = container.querySelector('[data-block="carousel"]');
    expect(block).not.toBeNull();
    const slides = container.querySelectorAll('.sbd-swiper-item');
    expect(slides).toHaveLength(3);
    const images = container.querySelectorAll('.sbd-image');
    expect([...images].every((image) => image.classList.contains('sbd-image--aspectFill'))).toBe(
      true,
    );
    const dots = container.querySelectorAll<HTMLElement>('.sbd-swiper__dot');
    expect(dots).toHaveLength(3);
    // #ffffff80 reaches the native attribute as rgba, which every base library takes.
    expect(dots[1]?.style.background).toMatch(/rgba\(255, 255, 255, 0\.502\)/);
    expect(dots[0]?.style.background).toMatch(/rgb\(255, 255, 255\)|#ffffff/);
    // The design height travels as a unitless custom property the stylesheet scales.
    const swiper = container.querySelector<HTMLElement>('.sbd-swiper');
    expect(swiper?.style.getPropertyValue('--sb-height')).toBe('340');
  });

  it('reports the typed link of the tapped slide', () => {
    const onLink = vi.fn();
    const { container } = render(<Carousel props={fixtureCarousel} onLink={onLink} />);
    const second = container.querySelectorAll('.sbd-image')[1];
    fireEvent.click(second as Element);
    expect(onLink).toHaveBeenCalledWith({ kind: 'product', id: '12' });
  });

  it('hides the dots for a single slide or when turned off', () => {
    const one = render(
      <Carousel props={{ ...fixtureCarousel, slides: fixtureCarousel.slides.slice(0, 1) }} />,
    );
    expect(one.container.querySelector('.sbd-swiper__dots')).toBeNull();
    one.unmount();
    const off = render(<Carousel props={{ ...fixtureCarousel, indicator: 'none' }} />);
    expect(off.container.querySelector('.sbd-swiper__dots')).toBeNull();
  });
});

describe('Carousel lazy slides', () => {
  const fiveSlides = {
    ...fixtureCarousel,
    autoplay: true,
    interval: 1000,
    slides: [0, 1, 2, 3, 4].map((n) => ({ ...fixtureCarousel.slides[0]!, image: `/s${n}.jpg` })),
  };
  /** Which slides have their picture mounted, by index. */
  const mounted = (container: HTMLElement) =>
    [...container.querySelectorAll('.sbd-swiper-item')].map(
      (slide) => slide.querySelector('img') !== null,
    );

  it('picks the slide shown and its two neighbours, wrapping around', () => {
    expect(slidesToLoad(0, 5)).toEqual([0, 1, 4]);
    expect(slidesToLoad(4, 5)).toEqual([4, 0, 3]);
    expect(slidesToLoad(0, 1)).toEqual([0]);
    expect(slidesToLoad(0, 0)).toEqual([]);
  });

  it('mounts a picture only once its slide is shown or next to it, and keeps it', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<Carousel props={fiveSlides} />);
      // The slides keep their boxes; only the pictures wait.
      expect(container.querySelectorAll('.sbd-swiper-item')).toHaveLength(5);
      expect(mounted(container)).toEqual([true, true, false, false, true]);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(mounted(container)).toEqual([true, true, true, false, true]);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(mounted(container)).toEqual([true, true, true, true, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('mounts every slide in the editor canvas', () => {
    const { container } = render(<Carousel props={fiveSlides} host={{ canvas: true }} />);
    expect(mounted(container)).toEqual([true, true, true, true, true]);
  });
});

describe('Block pictures', () => {
  const resolveImage = (src: string, width?: 480 | 960) =>
    width ? `https://api.test${src}@${width}` : `https://api.test${src}`;

  it('load the copy the host resolves, and the original when the copy fails', () => {
    const { container } = render(
      <HotspotImage props={{ ...fixtureHotspotImage, image: '/h.jpg' }} host={{ resolveImage }} />,
    );
    const img = () => container.querySelector('img') as HTMLImageElement;
    expect(img().getAttribute('src')).toBe('https://api.test/h.jpg@960');
    act(() => {
      fireEvent.error(img());
    });
    expect(img().getAttribute('src')).toBe('https://api.test/h.jpg');
  });

  it('load the stored URL as it is without a resolver', () => {
    const { container } = render(
      <HotspotImage props={{ ...fixtureHotspotImage, image: '/h.jpg' }} />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/h.jpg');
  });

  it('ask for the narrow copy in narrow spots', () => {
    const cells = fixtureImageCubeRow.cells.map((cell, n) => ({ ...cell, image: `/r${n}.jpg` }));
    const { container } = render(
      <ImageCube props={{ ...fixtureImageCubeRow, cells }} host={{ resolveImage }} />,
    );
    const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toEqual([
      'https://api.test/r0.jpg@480',
      'https://api.test/r1.jpg@480',
      'https://api.test/r2.jpg@480',
    ]);
  });

  it('load lazily on the storefront, eagerly in the editor canvas', () => {
    const lazy = (host?: { canvas: boolean }) => {
      const { container } = render(
        <>
          <ImageCube props={fixtureImageCube} host={host} />
          <HotspotImage props={fixtureHotspotImage} host={host} />
        </>,
      );
      return [...container.querySelectorAll('img')].map((img) => img.getAttribute('loading'));
    };
    expect(lazy()).toEqual(['lazy', 'lazy', 'lazy', 'lazy']);
    cleanup();
    expect(lazy({ canvas: true })).toEqual([null, null, null, null]);
  });
});

describe('ProductGrid', () => {
  it('renders the resolved products as cards, price split into yuan and fen', () => {
    render(<ProductGrid props={fixtureProductGrid} data={{ products: fixtureProducts }} />);
    expect(screen.getByText('秋季新款宽松针织开衫 女士百搭外套')).toBeTruthy();
    expect(screen.getByText('129')).toBeTruthy();
    expect(screen.getAllByText('.90').length).toBeGreaterThan(0);
    expect(screen.getByText('¥199.00')).toBeTruthy();
    expect(screen.getByText('新品')).toBeTruthy();
  });

  it('honours the display switches', () => {
    render(
      <ProductGrid
        props={{ ...fixtureProductGrid, showTag: false, showMarketPrice: false }}
        data={{ products: fixtureProducts }}
      />,
    );
    expect(screen.queryByText('新品')).toBeNull();
    expect(screen.queryByText('¥199.00')).toBeNull();
  });

  it('strikes no market price at or below the price', () => {
    const [first] = fixtureProducts;
    render(
      <ProductGrid
        props={fixtureProductGrid}
        data={{ products: [{ ...first!, marketPrice: '129.90' }] }}
      />,
    );
    expect(screen.queryByText('¥129.90')).toBeNull();
  });

  it('says so when the source resolved to nothing', () => {
    render(<ProductGrid props={fixtureProductGrid} data={{ products: [] }} />);
    expect(screen.getByText('暂无商品')).toBeTruthy();
  });

  it('links a card to its product', () => {
    const onLink = vi.fn();
    render(
      <ProductGrid
        props={fixtureProductGrid}
        data={{ products: fixtureProducts }}
        onLink={onLink}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: '厨房收纳三件套' }));
    expect(onLink).toHaveBeenCalledWith({ kind: 'product', id: '15' });
  });
});

describe('ImageCube', () => {
  it('draws left1right2 as three aspectFill cells and links each one', () => {
    const onLink = vi.fn();
    const { container } = render(<ImageCube props={fixtureImageCube} onLink={onLink} />);
    const images = container.querySelectorAll('.sbd-image');
    // The fourth cell is kept in the props but not shown by a three-cell layout.
    expect(images).toHaveLength(3);
    expect(images[0]?.classList.contains('sbd-image--aspectFill')).toBe(true);
    fireEvent.click(images[2] as Element);
    expect(onLink).toHaveBeenCalledWith({ kind: 'webview', url: 'https://example.com/promo' });
  });

  it('keeps each picture’s ratio in the row layouts (widthFix)', () => {
    const { container } = render(<ImageCube props={fixtureImageCubeRow} />);
    const images = container.querySelectorAll('.sbd-image');
    expect(images).toHaveLength(3);
    expect([...images].every((image) => image.classList.contains('sbd-image--widthFix'))).toBe(
      true,
    );
  });

  it('draws an empty cell rather than failing when a layout has too few pictures', () => {
    const { container } = render(
      <ImageCube
        props={{
          ...fixtureImageCube,
          layout: 'grid2x2',
          cells: fixtureImageCube.cells.slice(0, 2),
        }}
      />,
    );
    expect(container.querySelectorAll('.sbd-image')).toHaveLength(2);
  });
});

describe('BlockList', () => {
  it('renders known blocks in order and skips a type it does not know', () => {
    const { container } = render(
      <BlockList
        blocks={[
          { id: 'a', type: 'carousel', props: fixtureCarousel },
          { id: 'b', type: 'fromTheFuture', props: {} },
          { id: 'c', type: 'productGrid', props: fixtureProductGrid },
        ]}
        data={{ c: { products: fixtureProducts.slice(0, 2) } }}
      />,
    );
    const types = [...container.querySelectorAll('[data-block]')].map((node) =>
      node.getAttribute('data-block'),
    );
    expect(types).toEqual(['carousel', 'productGrid']);
  });
});
