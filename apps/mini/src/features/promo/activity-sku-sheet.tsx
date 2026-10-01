import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Button } from '@/ui/button';
import { Image } from '@/ui/image';
import { Pressable } from '@/ui/pressable';
import { Price } from '@/ui/price';
import { Sheet } from '@/ui/sheet';
import { Stepper } from '@/ui/stepper';
import './activity-sku-sheet.scss';

/** A 拼团 / 预售 SKU (`groupbuyStorefrontSku`, `presaleStorefrontSku`: the same shape). */
export interface ActivitySku {
  skuId: string;
  specText: string;
  specValues: Record<string, string>;
  imageUrl: string | null;
  price: string;
  originalPrice: string | null;
  stock: number;
}

export interface ActivitySkuSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  imageUrl: string | null;
  skus: readonly ActivitySku[];
  /** 每单限购份数. */
  perOrderQuantity: number;
  /** The button: 「发起拼团」「参与拼团」「立即预订」. */
  confirmText: string;
  /** Return the action's promise: the button stays locked until it settles (AGENTS 17). */
  onConfirm: (sku: ActivitySku, quantity: number) => void | Promise<unknown>;
}

/** A SKU's spec values in words: 「玫瑰 / 大号」, or 默认规格 for a product without specs. */
export function skuLabel(sku: Pick<ActivitySku, 'specText' | 'specValues'>): string {
  const values = Object.values(sku.specValues).filter(Boolean);
  if (values.length > 0) return values.join(' / ');
  return sku.specText.split('|').filter(Boolean).join(' / ') || '默认规格';
}

/** How many of a SKU one order may take: 1 up to the activity's limit and the SKU's stock. */
export function quantityMax(sku: Pick<ActivitySku, 'stock'> | null, perOrder: number): number {
  return sku ? Math.max(0, Math.min(perOrder, sku.stock)) : perOrder;
}

/**
 * The activity's own SKU picker: the activity lists its SKUs flat (one chip per variant, a
 * sold-out one greyed), so this is simpler than the product page's spec matrix. A single SKU is
 * picked already. The picks start over each time the sheet opens.
 */
export function ActivitySkuSheet({
  visible,
  onClose,
  title,
  imageUrl,
  skus,
  perOrderQuantity,
  confirmText,
  onConfirm,
}: ActivitySkuSheetProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setPicked(null);
      setQuantity(1);
    }
  }

  const only = skus.length === 1 ? skus[0] : undefined;
  const sku = skus.find((item) => item.skuId === picked) ?? only ?? null;
  const max = quantityMax(sku, perOrderQuantity);
  const count = Math.max(1, Math.min(quantity, max));
  const soldOut = sku !== null && sku.stock <= 0;
  const ready = sku !== null && !soldOut && max >= 1;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      className="activity-sku"
      footer={
        <Button
          block
          size="lg"
          disabled={!ready}
          onClick={() => (sku && ready ? onConfirm(sku, count) : undefined)}
        >
          {soldOut ? '已售罄' : confirmText}
        </Button>
      }
    >
      <View className="activity-sku__header">
        <View className="activity-sku__image">
          <Image
            src={sku?.imageUrl ?? imageUrl}
            label={title}
            radius="sm"
            lazy={false}
            size="small"
          />
        </View>
        <View className="activity-sku__summary">
          <Price value={sku?.price ?? skus[0]?.price ?? '0.00'} size="lg" />
          <Text className="activity-sku__meta">{sku ? `已选 ${skuLabel(sku)}` : '请选择规格'}</Text>
          {sku && sku.stock > 0 && sku.stock <= 10 ? (
            <Text className="activity-sku__meta">仅剩 {sku.stock} 件</Text>
          ) : null}
        </View>
      </View>
      {skus.length > 1 ? (
        <View className="activity-sku__section">
          <Text className="activity-sku__name">规格</Text>
          <View className="activity-sku__values">
            {skus.map((item) => {
              const out = item.stock <= 0;
              const selected = sku?.skuId === item.skuId;
              return (
                <Pressable
                  key={item.skuId}
                  label={`${skuLabel(item)}${out ? '，已售罄' : ''}`}
                  role="radio"
                  checked={selected}
                  disabled={out}
                  pressedTint={false}
                  className={cx(
                    'activity-sku__value',
                    selected && 'activity-sku__value--selected',
                    out && 'activity-sku__value--sold-out',
                  )}
                  onClick={() => setPicked(item.skuId)}
                >
                  {skuLabel(item)}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
      <View className="activity-sku__quantity">
        <Text className="activity-sku__name">数量</Text>
        <Text className="activity-sku__meta">每单限 {perOrderQuantity} 件</Text>
        <View className="activity-sku__stepper">
          <Stepper
            value={count}
            onChange={setQuantity}
            min={1}
            max={Math.max(1, max)}
            disabled={!ready}
            label="购买数量"
          />
        </View>
      </View>
    </Sheet>
  );
}
