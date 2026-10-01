import { ScrollView, Text, View } from '@tarojs/components';

import type { ProductLayout } from '@shop/contracts/decor/constants';
import type { LinkTarget } from '@shop/contracts/decor/link';
import type { ProductSummary } from '@shop/contracts/decor/sources';
import { BlockImage } from '../shared/block-image';
import { cx, tapProps } from '../shared/css';
import type { ImageResolver } from '../shared/types';
import styles from './product-cards.module.scss';

export interface ProductCardsProps {
  products: readonly ProductSummary[];
  /** Absent on a block stored before `layout` existed: the two-column grid it was. */
  layout?: ProductLayout | undefined;
  titleLines: 1 | 2;
  showMarketPrice: boolean;
  showTag: boolean;
  onLink?: ((target: LinkTarget) => void) | undefined;
  /** The host's picture resolver (`BlockHost.resolveImage`). */
  resolveImage?: ImageResolver | undefined;
}

/** `"129.90"` → `["129", ".90"]`, so the yuan can be drawn larger than the fen. */
export function splitPrice(price: string): [string, string] {
  const dot = price.indexOf('.');
  return dot < 0 ? [price, ''] : [price.slice(0, dot), price.slice(dot)];
}

const LAYOUT_CLASS: Record<ProductLayout, string | undefined> = {
  grid2: styles.grid2,
  grid3: styles.grid3,
  list: styles.list,
  scroll: styles.scroll,
};

/**
 * The product cards every product block draws (商品列表, 商品选项卡): a
 * two- or three-column grid, a one-column list, or a horizontal scroller.
 * One card, four arrangements — so a price looks the same wherever it is.
 */
export function ProductCards({
  products,
  layout = 'grid2',
  titleLines,
  showMarketPrice,
  showTag,
  onLink,
  resolveImage,
}: ProductCardsProps) {
  if (products.length === 0) return <View className={styles.empty}>暂无商品</View>;
  // Half the screen wide in the two-column grid; a third or less elsewhere.
  const imageWidth = layout === 'grid2' ? 960 : 480;
  const cards = products.map((product) => {
    const [yuan, fen] = splitPrice(product.price);
    return (
      <View
        key={product.id}
        className={cx(styles.card, product.soldOut && styles.soldOut)}
        {...(onLink
          ? { ariaRole: 'link', ariaLabel: `${product.title}${product.soldOut ? '，已售罄' : ''}` }
          : {})}
        {...tapProps(onLink ? () => onLink({ kind: 'product', id: product.id }) : undefined)}
      >
        <View className={styles.media}>
          <BlockImage
            className={styles.image}
            src={product.image}
            width={imageWidth}
            resolve={resolveImage}
            mode="aspectFill"
            lazyLoad
          />
          {showTag && product.tag ? <Text className={styles.tag}>{product.tag}</Text> : null}
          {product.soldOut ? <View className={styles.soldOutMark}>已售罄</View> : null}
        </View>
        <View className={styles.body}>
          <View className={cx(styles.title, titleLines === 1 ? styles.lines1 : styles.lines2)}>
            {product.title}
          </View>
          <View className={styles.prices}>
            <Text className={styles.price}>
              <Text className={styles.minor}>¥</Text>
              {yuan}
              <Text className={styles.minor}>{fen}</Text>
            </Text>
            {showMarketPrice &&
            product.marketPrice &&
            Number(product.marketPrice) > Number(product.price) ? (
              <Text className={styles.market}>¥{product.marketPrice}</Text>
            ) : null}
          </View>
        </View>
      </View>
    );
  });
  if (layout === 'scroll') {
    return (
      <ScrollView className={cx(styles.cards, styles.scroll)} scrollX enableFlex>
        <View className={styles.track}>{cards}</View>
      </ScrollView>
    );
  }
  return <View className={cx(styles.cards, LAYOUT_CLASS[layout])}>{cards}</View>;
}
