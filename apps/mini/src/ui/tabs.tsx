import { ScrollView, Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Pressable } from './pressable';
import './tabs.scss';

export interface TabItem<K extends string> {
  key: K;
  label: string;
  /** A count after the label (待付款 3). 0 or none shows nothing. */
  count?: number | undefined;
}

export interface TabsProps<K extends string> {
  items: ReadonlyArray<TabItem<K>>;
  value: K;
  onChange: (key: K) => void;
  /** Sticks to the top of the page while the list scrolls. */
  sticky?: boolean | undefined;
  /** Scrolls sideways when the tabs do not fit (≥ 5 tabs); otherwise they share the width. */
  scrollable?: boolean | undefined;
  className?: string | undefined;
}

/** Horizontal tabs with a primary underline (design.md §4.5). Selection is bold, not colour only. */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  sticky,
  scrollable = items.length > 4,
  className,
}: TabsProps<K>) {
  const row = (
    <View className="shop-tabs__row" ariaRole="tablist">
      {items.map((item) => {
        const selected = item.key === value;
        return (
          <Pressable
            key={item.key}
            id={`shop-tab-${item.key}`}
            role="tab"
            label={item.count ? `${item.label} ${item.count}` : item.label}
            selected={selected}
            pressedTint={false}
            className={cx('shop-tabs__tab', selected && 'shop-tabs__tab--selected')}
            onClick={() => {
              if (!selected) onChange(item.key);
            }}
          >
            <Text className="shop-tabs__label">{item.label}</Text>
            {item.count ? (
              <Text className="shop-tabs__count">{item.count > 99 ? '99+' : item.count}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
  return (
    <View
      className={cx(
        'shop-tabs',
        sticky && 'shop-tabs--sticky',
        scrollable && 'shop-tabs--scroll',
        className,
      )}
    >
      {scrollable ? (
        <ScrollView
          scrollX
          enhanced
          showScrollbar={false}
          scrollWithAnimation
          scrollIntoView={`shop-tab-${value}`}
          className="shop-tabs__scroller"
        >
          {row}
        </ScrollView>
      ) : (
        row
      )}
    </View>
  );
}
