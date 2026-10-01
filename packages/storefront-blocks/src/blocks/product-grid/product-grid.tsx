import type { ProductGridProps } from '@shop/contracts/decor/all-blocks';
import type { ProductSummary } from '@shop/contracts/decor/sources';
import { BlockFrame } from '../shared/frame';
import type { BlockProps } from '../shared/types';
import { ProductCards } from './product-cards';

export interface ProductGridData {
  products: ProductSummary[];
}

/**
 * 商品列表 (`productGrid`): product cards from a declarative source, in the
 * layout the operator chose. The products arrive resolved in `data`.
 */
export function ProductGrid({
  props,
  data,
  onLink,
  host,
}: BlockProps<ProductGridProps, ProductGridData>) {
  return (
    <BlockFrame type="productGrid" frame={props.style}>
      <ProductCards
        products={data?.products ?? []}
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
