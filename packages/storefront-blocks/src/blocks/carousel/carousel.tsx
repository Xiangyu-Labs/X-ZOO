import { Swiper, SwiperItem } from '@tarojs/components';
import { useState } from 'react';

import type { CarouselProps } from '@shop/contracts/decor/all-blocks';
import { BlockImage } from '../shared/block-image';
import { cssColor, designVars, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import type { BlockProps } from '../shared/types';
import styles from './carousel.module.scss';

/**
 * The slides worth loading while `current` shows: itself and its two
 * neighbours (the swiper is circular, so the last slide is the first one's
 * left neighbour). Autoplay and a swipe both land on a neighbour, which is
 * then already loaded.
 */
export function slidesToLoad(current: number, count: number): number[] {
  if (count <= 0) return [];
  return [...new Set([current, (current + 1) % count, (current - 1 + count) % count])];
}

/**
 * 轮播: full-width slides, each optionally linking somewhere.
 *
 * A slide's picture is mounted only once the slide is shown or next to the
 * one shown, so a six-slide banner costs three pictures on arrival rather than
 * six. WeChat's own `lazy-load` does not help here: it goes by vertical
 * distance, and every slide sits at the same height. The swiper's height is
 * fixed by the block (`height`), so a slide waiting for its picture keeps its
 * size and nothing moves. The editor canvas mounts every slide.
 */
export function Carousel({ props, onLink, host }: BlockProps<CarouselProps>) {
  const { slides } = props;
  const everySlide = host?.canvas === true;
  const [loaded, setLoaded] = useState<ReadonlySet<number>>(
    () => new Set(slidesToLoad(0, slides.length)),
  );
  const onChange = (event: { detail: { current: number } }) => {
    const wanted = slidesToLoad(event.detail.current, slides.length);
    setLoaded((previous) =>
      wanted.every((index) => previous.has(index)) ? previous : new Set([...previous, ...wanted]),
    );
  };
  return (
    <BlockFrame type="carousel" frame={props.style}>
      <Swiper
        className={styles.swiper}
        style={designVars({ height: props.height })}
        autoplay={props.autoplay && slides.length > 1}
        interval={props.interval}
        circular
        indicatorDots={props.indicator === 'dots' && slides.length > 1}
        indicatorColor={cssColor(props.indicatorColor)}
        indicatorActiveColor={cssColor(props.indicatorActiveColor)}
        onChange={onChange}
      >
        {slides.map((slide, index) => {
          const link = slide.link;
          return (
            <SwiperItem key={index} className={styles.slide}>
              {everySlide || loaded.has(index) ? (
                <BlockImage
                  className={styles.image}
                  src={slide.image}
                  width={960}
                  resolve={host?.resolveImage}
                  mode="aspectFill"
                  ariaLabel={slide.alt || undefined}
                  {...tapProps(link && onLink ? () => onLink(link) : undefined)}
                />
              ) : null}
            </SwiperItem>
          );
        })}
      </Swiper>
    </BlockFrame>
  );
}
