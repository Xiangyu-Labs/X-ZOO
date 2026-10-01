import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { formatSpec } from '@/lib/spec';
import { navigate } from '@/platform';
import { Checkbox } from '@/ui/choice';
import { Icon } from '@/ui/icon';
import { Image } from '@/ui/image';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { Stepper } from '@/ui/stepper';
import {
  quantityCeiling,
  quantityFloor,
  quantityRuleText,
  rescueQuantity,
  unavailableReason,
  type CartItem,
} from './cart-view';
import './cart-row.scss';

export interface CartRowProps {
  item: CartItem;
  /** The quantity being saved, shown until the cart answers. */
  quantity?: number | undefined;
  onSelect?: ((selected: boolean) => void) | undefined;
  onQuantity?: ((quantity: number) => void) | undefined;
  /** 改规格: opens the SkuSheet on this row. */
  onSpec?: (() => void) | undefined;
}

/**
 * One cart row (design.md §4.4): tick, picture, name, spec (tap to change it), price and a
 * stepper capped at the live stock. A row that cannot be checked out is greyed with its reason;
 * one that is only short of stock offers 「改为 N 件」.
 */
export function CartRow({ item, quantity, onSelect, onQuantity, onSpec }: CartRowProps) {
  const open = () => void navigate({ route: 'product', params: { id: item.productId } });
  const rescue = item.available ? null : rescueQuantity(item);
  const specs = formatSpec(item.specText);
  // A live row's rule is a lifetime limit: said up front, not first at 结算.
  const note = item.available ? quantityRuleText(item) : null;
  return (
    <View className={cx('cart-row', !item.available && 'cart-row--off')} id={`cart-row-${item.id}`}>
      {item.available ? (
        <Checkbox
          label={`选择 ${item.productName}`}
          checked={item.isSelected}
          onChange={onSelect}
          className="cart-row__check"
        >
          {/* The mark alone: the label is announced, not shown. */}
          <View />
        </Checkbox>
      ) : (
        <Text className="cart-row__off-tag">失效</Text>
      )}
      <Pressable
        label={`${item.productName}的图片`}
        role="link"
        className="cart-row__media"
        onClick={open}
      >
        <Image src={item.skuImageUrl ?? item.productImageUrl} ratio={1} radius="sm" size="small" />
      </Pressable>
      <View className="cart-row__body">
        <Pressable label={item.productName} role="link" pressedTint={false} onClick={open}>
          <Text className="cart-row__name">{item.productName}</Text>
        </Pressable>
        {specs ? (
          item.available && onSpec ? (
            <Pressable
              label={`规格 ${specs}，修改规格`}
              className="cart-row__spec cart-row__spec--button"
              onClick={onSpec}
            >
              <Text className="cart-row__spec-text">{specs}</Text>
              <Icon name="chevron-down" className="cart-row__spec-icon" />
            </Pressable>
          ) : (
            <Text className="cart-row__spec">{specs}</Text>
          )
        ) : null}
        {item.available ? (
          note ? (
            <Text className="cart-row__note">{note}</Text>
          ) : null
        ) : (
          <Text className="cart-row__reason">{unavailableReason(item)}</Text>
        )}
        <View className="cart-row__foot">
          <Price value={item.unitPrice} size="sm" />
          {item.available ? (
            <Stepper
              value={quantity ?? item.quantity}
              min={quantityFloor(item)}
              max={quantityCeiling(item)}
              label={`${item.productName}的数量`}
              onChange={(next) => onQuantity?.(next)}
            />
          ) : rescue !== null && onQuantity ? (
            <Pressable
              label={`改为 ${rescue} 件`}
              className="cart-row__rescue"
              onClick={() => onQuantity(rescue)}
            >
              <Text>改为 {rescue} 件</Text>
            </Pressable>
          ) : (
            <Text className="cart-row__qty">×{item.quantity}</Text>
          )}
        </View>
      </View>
    </View>
  );
}
