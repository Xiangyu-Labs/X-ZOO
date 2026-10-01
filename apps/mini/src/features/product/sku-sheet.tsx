import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { assetUrl } from '@/lib/asset-url';
import { cx } from '@/lib/cx';
import { previewImages } from '@/platform';
import { Button } from '@/ui/button';
import { Image } from '@/ui/image';
import { Pressable } from '@/ui/pressable';
import { Price } from '@/ui/price';
import { Sheet } from '@/ui/sheet';
import { Skeleton } from '@/ui/skeleton';
import { Stepper } from '@/ui/stepper';
import {
  initialSelection,
  missingSpecs,
  quantityBounds,
  selectedSku,
  selectionText,
  specsOf,
  toggleValue,
  valueState,
  type PurchaseRules,
  type Sku,
  type SkuMatrix,
  type SkuSelection,
} from './sku-select';
import './sku-sheet.scss';

/** What the sheet's buttons do; `both` shows 加入购物车 and 立即购买 side by side. */
export type SkuAction = 'cart' | 'buy';

export interface SkuSheetProduct extends PurchaseRules {
  name: string;
  imageUrl: string;
  price: string;
  unitName?: string | null | undefined;
}

export interface SkuSheetProps {
  visible: boolean;
  onClose: () => void;
  product: SkuSheetProduct;
  /** `undefined` while the SKUs load. */
  matrix: SkuMatrix | undefined;
  /** Which buttons: one action, both, or `confirm` (确定, e.g. 改规格 in the cart). */
  actions: readonly SkuAction[] | 'confirm';
  /** Return the action's promise: the button stays locked until it settles (AGENTS 17). */
  onConfirm: (action: SkuAction | 'confirm', sku: Sku, quantity: number) => void | Promise<unknown>;
  /** The SKU to start from (a cart row being changed). */
  skuId?: string | undefined;
  initialQuantity?: number | undefined;
  /** An action in flight: its button spins, the others wait. */
  busy?: SkuAction | 'confirm' | null | undefined;
}

const LABEL: Record<SkuAction | 'confirm', string> = {
  cart: '加入购物车',
  buy: '立即购买',
  confirm: '确定',
};

/**
 * 规格选择 (design.md §4.4 SkuSheet): the variant's picture, price and stock, the spec values
 * (sold-out ones greyed), the quantity, and the caller's buttons. Until every spec is picked
 * the buttons stay disabled and the header says what is missing.
 *
 * The picks start over each time the sheet opens.
 */
export function SkuSheet({
  visible,
  onClose,
  product,
  matrix,
  actions,
  onConfirm,
  skuId,
  initialQuantity,
  busy,
}: SkuSheetProps) {
  const [picked, setPicked] = useState<SkuSelection | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setPicked(null);
      setQuantity(null);
    }
  }

  const selection = picked ?? (matrix ? initialSelection(matrix, skuId) : {});
  const sku = matrix ? selectedSku(matrix, selection) : null;
  const bounds = quantityBounds(sku, product);
  const wanted = quantity ?? initialQuantity ?? bounds.min;
  const count = Math.max(bounds.min, Math.min(wanted, Math.max(bounds.max, bounds.min)));
  const soldOut = sku !== null && sku.stock === 0;
  const tooFew = sku !== null && bounds.max < bounds.min;
  const missing = matrix ? missingSpecs(matrix, selection) : [];
  const ready = sku !== null && !soldOut && !tooFew;
  const buttons: ReadonlyArray<SkuAction | 'confirm'> =
    actions === 'confirm' ? ['confirm'] : actions;

  const footer = (
    <View className="sku-sheet__buttons">
      {buttons.map((action, index) => (
        <Button
          key={action}
          block
          size="lg"
          variant={buttons.length > 1 && index === 0 ? 'secondary' : 'primary'}
          disabled={!ready || (busy != null && busy !== action)}
          loading={busy === action}
          onClick={() => (sku && ready ? onConfirm(action, sku, count) : undefined)}
        >
          {soldOut ? '已售罄' : LABEL[action]}
        </Button>
      ))}
    </View>
  );

  return (
    <Sheet visible={visible} onClose={onClose} footer={footer}>
      {!matrix ? (
        <View className="sku-sheet__loading" id="sku-sheet-loading">
          <Skeleton className="sku-sheet__loading-image" />
          <Skeleton className="sku-sheet__loading-line" />
        </View>
      ) : (
        <View className="sku-sheet" id="sku-sheet">
          <Header product={product} sku={sku} text={selectionText(matrix, selection)} />
          {specsOf(matrix).map((spec) => (
            <View key={spec.name} className="sku-sheet__spec">
              <Text className="sku-sheet__spec-name">{spec.name}</Text>
              <View className="sku-sheet__values">
                {spec.values.map(({ value }) => {
                  const state = valueState(matrix, selection, spec.name, value);
                  return (
                    <Pressable
                      key={value}
                      label={state === 'sold-out' ? `${value}，已售罄` : value}
                      role="radio"
                      checked={state === 'selected'}
                      disabled={state === 'sold-out'}
                      pressedTint={false}
                      className={cx('sku-sheet__value', `sku-sheet__value--${state}`)}
                      onClick={() => setPicked(toggleValue(selection, spec.name, value))}
                    >
                      {value}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))}
          <View className="sku-sheet__quantity">
            <Text className="sku-sheet__spec-name">数量</Text>
            {bounds.max > 0 &&
            product.purchaseLimitMode &&
            product.purchaseLimitMode !== 'none' &&
            product.purchaseLimitQuantity ? (
              <Text className="sku-sheet__limit">
                {product.purchaseLimitMode === 'lifetime' ? '每人' : '每单'}限购{' '}
                {product.purchaseLimitQuantity} 件
              </Text>
            ) : null}
            <Stepper
              value={count}
              min={bounds.min}
              max={Math.max(bounds.min, bounds.max)}
              disabled={!ready}
              onChange={setQuantity}
            />
          </View>
          {missing.length === 0 && tooFew ? (
            <Text className="sku-sheet__warning">库存不足</Text>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}

function Header({
  product,
  sku,
  text,
}: {
  product: SkuSheetProduct;
  sku: Sku | null;
  text: string;
}) {
  const image = assetUrl(sku?.imageUrl ?? product.imageUrl);
  return (
    <View className="sku-sheet__header">
      <Pressable
        label="查看大图"
        className="sku-sheet__image"
        onClick={() => {
          if (image) previewImages([image], image);
        }}
      >
        <Image src={image} label={product.name} radius="sm" size="small" />
      </Pressable>
      <View className="sku-sheet__summary">
        <Price value={sku?.price ?? product.price} size="lg" />
        {sku ? (
          <Text className="sku-sheet__stock">
            库存 {sku.stock}
            {product.unitName ?? '件'}
          </Text>
        ) : null}
        <Text className="sku-sheet__picked">{text}</Text>
      </View>
    </View>
  );
}
