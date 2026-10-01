import { fireEvent } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, render } from '../test/render';
import { Image, ScrollView, Swiper, SwiperItem, Text, View } from './index';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DOM shim', () => {
  it('View / Text are div / span, forward data-* and report taps as Taro-shaped events', () => {
    const onClick = vi.fn();
    const { container } = render(
      <View id="v" className="box" data-kind="x" onClick={onClick}>
        <Text>hi</Text>
      </View>,
    );
    const view = container.querySelector('#v') as HTMLElement;
    expect(view.tagName).toBe('DIV');
    expect(view.className).toBe('sbd-view box');
    expect(view.dataset.kind).toBe('x');
    expect(container.querySelector('span.sbd-text')?.textContent).toBe('hi');
    fireEvent.click(view);
    expect(onClick.mock.calls[0]?.[0]).toMatchObject({
      type: 'tap',
      currentTarget: { id: 'v', dataset: { kind: 'x' } },
    });
  });

  it('Image defaults to scaleToFill, as WeChat does, and maps every mode to a class', () => {
    const { container, rerender } = render(<Image src="/a.png" />);
    expect(container.querySelector('.sbd-image')?.className).toContain('sbd-image--scaleToFill');
    rerender(<Image src="/a.png" mode="top left" />);
    expect(container.querySelector('.sbd-image')?.className).toContain('sbd-image--top-left');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/a.png');
  });

  it('Swiper autoplays every interval, wraps to the first item and reports each change', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(
      <Swiper autoplay interval={1000} indicatorDots onChange={onChange}>
        <SwiperItem>1</SwiperItem>
        <SwiperItem>2</SwiperItem>
      </Swiper>,
    );
    const track = container.querySelector<HTMLElement>('.sbd-swiper__track');
    expect(track?.style.transform).toBe('translate3d(0%, 0, 0)');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(track?.style.transform).toBe('translate3d(-100%, 0, 0)');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ current: 1, source: 'autoplay' }),
      }),
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(track?.style.transform).toBe('translate3d(0%, 0, 0)');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('Swiper follows a controlled `current`', () => {
    const { container, rerender } = render(
      <Swiper current={0}>
        <SwiperItem>1</SwiperItem>
        <SwiperItem>2</SwiperItem>
        <SwiperItem>3</SwiperItem>
      </Swiper>,
    );
    rerender(
      <Swiper current={2}>
        <SwiperItem>1</SwiperItem>
        <SwiperItem>2</SwiperItem>
        <SwiperItem>3</SwiperItem>
      </Swiper>,
    );
    expect(container.querySelector<HTMLElement>('.sbd-swiper__track')?.style.transform).toBe(
      'translate3d(-200%, 0, 0)',
    );
  });

  it('ScrollView scrolls on the axes it is given and hides the scrollbar by default', () => {
    const { container } = render(
      <ScrollView scrollX>
        <View>a</View>
      </ScrollView>,
    );
    const scroll = container.querySelector('.sbd-scroll');
    expect(scroll?.classList.contains('sbd-scroll--x')).toBe(true);
    expect(scroll?.classList.contains('sbd-scroll--y')).toBe(false);
    expect(scroll?.classList.contains('sbd-scroll--hidebar')).toBe(true);
  });
});
