import { useState, type ReactNode } from 'react';
import { View } from '@tarojs/components';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/choice';
import { ProductCard, type ProductCardData } from '@/ui/product-card';
import { SubmitBar } from './form';
import './manage.scss';

/** 管理 mode on a product list (收藏, 浏览记录): which rows are ticked. */
export function useSelection() {
  const [managing, setManaging] = useState(false);
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  return {
    managing,
    ids,
    toggleManaging() {
      setManaging((on) => !on);
      setIds(new Set());
    },
    toggle(id: string) {
      setIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    setAll(all: readonly string[], on: boolean) {
      setIds(on ? new Set(all) : new Set());
    },
    clear() {
      setIds(new Set());
    },
  };
}

export type Selection = ReturnType<typeof useSelection>;

/**
 * A product row: a list card, with a tick box in front while managing (a tap then ticks).
 * `unavailable` (the list's `available: false`) greys it out as 已下架; its tick box still works,
 * so the shopper can remove it.
 */
export function ProductRow({
  product,
  selection,
  unavailable,
  aside,
}: {
  product: ProductCardData;
  selection: Selection;
  unavailable?: boolean | undefined;
  aside?: ReactNode;
}) {
  const on = selection.ids.has(product.id);
  return (
    <View className="manage-row">
      {selection.managing ? (
        <Checkbox
          className="manage-row__check"
          label={`选择 ${product.name}`}
          checked={on}
          onChange={() => selection.toggle(product.id)}
        >
          {/* The mark only: the card beside it says what it is. */}
          <View />
        </Checkbox>
      ) : null}
      <View className="manage-row__card">
        <ProductCard
          product={product}
          layout="list"
          unavailable={unavailable}
          {...(selection.managing ? { onClick: () => selection.toggle(product.id) } : {})}
        />
        {aside}
      </View>
    </View>
  );
}

/** The bottom bar while managing: 全选 and the action on the ticked rows. */
export function ManageBar({
  selection,
  all,
  action,
  busy,
  onAction,
}: {
  selection: Selection;
  all: readonly string[];
  action: string;
  busy?: boolean | undefined;
  onAction: (ids: string[]) => void;
}) {
  const count = selection.ids.size;
  const allOn = all.length > 0 && all.every((id) => selection.ids.has(id));
  return (
    <SubmitBar>
      <View className="manage-bar">
        <Checkbox
          label="全选"
          checked={allOn}
          onChange={(checked) => selection.setAll(all, checked)}
        />
        <Button
          variant="outline-primary"
          size="md"
          disabled={count === 0}
          loading={busy}
          onClick={() => onAction([...selection.ids])}
        >
          {count > 0 ? `${action}（${count}）` : action}
        </Button>
      </View>
    </SubmitBar>
  );
}
