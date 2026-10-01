import { Swiper, SwiperItem, View } from '@tarojs/components';
import { useState } from 'react';

import type { NavGridItem, NavGridProps } from '@shop/contracts/decor/all-blocks';
import type { LinkTarget } from '@shop/contracts/decor/link';
import { BlockImage } from '../shared/block-image';
import { cx, designVars, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import type { BlockProps, ImageResolver } from '../shared/types';
import styles from './nav-grid.module.scss';

function chunk<T>(items: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let at = 0; at < items.length; at += size) pages.push(items.slice(at, at + size));
  return pages;
}

function Cells({
  items,
  props,
  onLink,
  resolveImage,
}: {
  items: readonly NavGridItem[];
  props: NavGridProps;
  onLink: ((target: LinkTarget) => void) | undefined;
  resolveImage: ImageResolver | undefined;
}) {
  return (
    <View className={cx(styles.cells, props.columns === 4 ? styles.cols4 : styles.cols5)}>
      {items.map((item, index) => {
        const link = item.link;
        return (
          <View
            key={index}
            className={styles.cell}
            {...tapProps(link && onLink ? () => onLink(link) : undefined)}
          >
            <BlockImage
              className={cx(styles.icon, props.iconShape === 'circle' && styles.circle)}
              src={item.icon}
              width={480}
              resolve={resolveImage}
              mode="aspectFill"
            />
            <View className={styles.label}>{item.label}</View>
          </View>
        );
      })}
    </View>
  );
}

/**
 * 导航宫格: icon entries, 4 or 5 to a row. With `paging`, `rows` rows per page
 * and the rest on further pages, swiped sideways, with the page dots below.
 */
export function NavGrid({ props, onLink, host }: BlockProps<NavGridProps>) {
  const [page, setPage] = useState(0);
  const pages = props.paging ? chunk(props.items, props.columns * props.rows) : [props.items];
  if (pages.length <= 1) {
    return (
      <BlockFrame type="navGrid" frame={props.style} className={styles.body}>
        <Cells
          items={props.items}
          props={props}
          onLink={onLink}
          resolveImage={host?.resolveImage}
        />
      </BlockFrame>
    );
  }
  return (
    <BlockFrame type="navGrid" frame={props.style} className={styles.body}>
      <Swiper
        className={styles.pages}
        style={designVars({ rows: props.rows })}
        onChange={(event) => setPage(event.detail.current)}
      >
        {pages.map((items, index) => (
          <SwiperItem key={index}>
            <Cells items={items} props={props} onLink={onLink} resolveImage={host?.resolveImage} />
          </SwiperItem>
        ))}
      </Swiper>
      <View className={styles.dots}>
        {pages.map((_items, index) => (
          <View key={index} className={cx(styles.dot, index === page && styles.dotActive)} />
        ))}
      </View>
    </BlockFrame>
  );
}
