import { View } from '@tarojs/components';
import { useState } from 'react';

import type { ProductTabsProps } from '@shop/contracts/decor/all-blocks';
import { productTabSlot } from '@shop/contracts/decor/constants';
import type { ProductSummary } from '@shop/contracts/decor/sources';
import { ProductCards } from '../product-grid/product-cards';
import { cx, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import type { BlockProps } from '../shared/types';
import styles from './product-tabs.module.scss';

/** Resolved products by tab slot (`tab0`, `tab1`, …); a slot is `null` when it failed to load. */
export type ProductTabsData = Record<string, ProductSummary[] | null>;

/**
 * 商品选项卡: tabs over one product list. Every tab's products came with the
 * page, so switching is local state and instant.
 */
export function ProductTabs({
  props,
  data,
  onLink,
  host,
}: BlockProps<ProductTabsProps, ProductTabsData>) {
  const [active, setActive] = useState(0);
  const current = Math.min(active, props.tabs.length - 1);
  return (
    <BlockFrame type="productTabs" frame={props.style}>
      <View className={styles.tabs}>
        {props.tabs.map((tab, index) => (
          <View
            key={index}
            className={cx(styles.tab, index === current && styles.active)}
            {...tapProps(() => setActive(index))}
          >
            <View className={styles.label}>{tab.title}</View>
          </View>
        ))}
      </View>
      <ProductCards
        products={data?.[productTabSlot(current)] ?? []}
        layout={props.layout}
        titleLines={props.titleLines}
        showMarketPrice={props.showMarketPrice}
        showTag={props.showTag}
        onLink={onLink}
        resolveImage={host?.resolveImage}
      />
    </BlockFrame>
  );
}
