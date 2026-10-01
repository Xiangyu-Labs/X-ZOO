import type { ProductCard as ProductCardDto } from '@shop/contracts/catalog/schemas';
import { Image as TaroImage, Text, View } from '@tarojs/components';
import { assetUrl } from '@/lib/asset-url';
import { cx } from '@/lib/cx';
import { strikePrice } from '@/lib/money';
import { navigate } from '@/platform';
import { Icon } from './icon';
import { Image } from './image';
import { Price } from './price';
import { Pressable } from './pressable';
import './product-card.scss';

/** The fields the card shows of the contract's shared `productCard`. */
export type ProductCardData = Pick<
  ProductCardDto,
  | 'id'
  | 'name'
  | 'subtitle'
  | 'imageUrl'
  | 'cardImageUrl'
  | 'price'
  | 'originalPrice'
  | 'stock'
  | 'salesDisplay'
  | 'labels'
  | 'canAddToCart'
>;

export type ProductCardLayout = 'grid' | 'list' | 'mini';

export interface ProductCardProps {
  product: ProductCardData;
  /** `grid` (two columns), `list` (picture left), `mini` (a narrow card in a sideways row). */
  layout?: ProductCardLayout | undefined;
  /** An activity's corner tag: 「拼团」「预售」「限时活动」. */
  activity?: string | undefined;
  /** The activity price, shown instead of `product.price` (the list price is then struck). */
  activityPrice?: string | undefined;
  /** 已下架: the whole card greys out and does nothing. */
  unavailable?: boolean | undefined;
  /** Opens the product by default. */
  onClick?: (() => void | Promise<unknown>) | undefined;
  /** Shows the round 加购 button (grid and list) when the product can go in a cart. */
  onAddToCart?: (() => void | Promise<unknown>) | undefined;
  className?: string | undefined;
}

/** `1.2万` past ten thousand: the uni-app's 已售 wording. */
export function formatSales(count: number): string {
  if (count >= 10000) return `${(Math.floor(count / 1000) / 10).toString()}万`;
  return String(count);
}

/**
 * A product in a list (design.md §4.4): picture, two-line name, labels, price, 划线价, 已售.
 * Sold out puts 「已售罄」 over the picture and drops the cart button; 已下架 greys the card.
 */
export function ProductCard({
  product,
  layout = 'grid',
  activity,
  activityPrice,
  unavailable = false,
  onClick,
  onAddToCart,
  className,
}: ProductCardProps) {
  const soldOut = product.stock <= 0;
  const price = activityPrice ?? product.price;
  const strike = strikePrice(price, activityPrice ? product.price : product.originalPrice);
  const showCart =
    Boolean(onAddToCart) && product.canAddToCart && !soldOut && !unavailable && layout !== 'mini';
  const open = onClick ?? (() => navigate({ route: 'product', params: { id: product.id } }));
  const state = unavailable ? '，已下架' : soldOut ? '，已售罄' : '';

  return (
    <Pressable
      label={`${product.name}${state}`}
      role="link"
      disabled={unavailable}
      onClick={open}
      className={cx(
        'shop-product',
        `shop-product--${layout}`,
        unavailable && 'shop-product--unavailable',
        className,
      )}
    >
      <View className="shop-product__media">
        <Image
          src={(layout === 'grid' ? product.cardImageUrl : null) ?? product.imageUrl}
          ratio={1}
          radius={layout === 'list' ? 'sm' : 'none'}
          size={layout === 'grid' ? 'medium' : 'small'}
        />
        {activity ? <Text className="shop-product__activity">{activity}</Text> : null}
        {unavailable || soldOut ? (
          <View className="shop-product__veil" ariaHidden>
            <Text className="shop-product__veil-text">{unavailable ? '已下架' : '已售罄'}</Text>
          </View>
        ) : null}
      </View>
      <View className="shop-product__body">
        <Text className="shop-product__name">{product.name}</Text>
        {layout === 'list' && product.subtitle ? (
          <Text className="shop-product__subtitle">{product.subtitle}</Text>
        ) : null}
        {layout !== 'mini' && product.labels.length > 0 ? (
          <View className="shop-product__labels">
            {product.labels.slice(0, 3).map((label) =>
              label.style === 'image' && label.imageUrl ? (
                <TaroImage
                  key={label.id}
                  className="shop-product__label-image"
                  src={assetUrl(label.imageUrl) ?? ''}
                  mode="heightFix"
                  ariaLabel={label.name}
                />
              ) : (
                <Text
                  key={label.id}
                  className="shop-product__label"
                  style={{
                    ...(label.fontColor ? { color: label.fontColor } : {}),
                    ...(label.backgroundColor ? { backgroundColor: label.backgroundColor } : {}),
                    ...(label.borderColor ? { borderColor: label.borderColor } : {}),
                  }}
                >
                  {label.name}
                </Text>
              ),
            )}
          </View>
        ) : null}
        <View className="shop-product__foot">
          <View className="shop-product__prices">
            <Price value={price} size={layout === 'mini' ? 'sm' : 'md'} />
            {strike && layout !== 'mini' ? <Price value={strike} size="sm" strike /> : null}
          </View>
          {showCart ? (
            <Pressable
              label={`加入购物车 ${product.name}`}
              className="shop-product__cart"
              pressedTint={false}
              stopPropagation
              onClick={() => onAddToCart?.()}
            >
              <Icon name="cart" />
            </Pressable>
          ) : null}
        </View>
        {layout !== 'mini' && product.salesDisplay > 0 ? (
          <Text className="shop-product__sales">已售 {formatSales(product.salesDisplay)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}
