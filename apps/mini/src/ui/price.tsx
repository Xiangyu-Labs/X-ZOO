import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import './price.scss';

export interface PriceProps {
  /** The contract's money string (`"199.00"`): never parsed to a float. */
  value: string;
  size?: 'lg' | 'md' | 'sm' | undefined;
  /** 划线价: grey and struck through, read as 「原价」. */
  strike?: boolean | undefined;
  /** A word before it: 「到手价」, 「券后」. */
  prefix?: string | undefined;
  /** Colour: the price colour (default), or the text colour for a total that is not a price. */
  tone?: 'price' | 'text' | undefined;
  className?: string | undefined;
}

/** `"199.5"` → `["199", ".50"]`; a value without decimals gets none. */
export function splitMoney(value: string): [string, string] {
  const [whole = '0', fraction] = value.trim().split('.');
  if (fraction === undefined) return [whole, ''];
  return [whole, `.${fraction.padEnd(2, '0').slice(0, 2)}`];
}

/**
 * ¥**199**.00 (design.md §1.3): the yuan sign and the decimals a size smaller. Announced as
 * 「价格 199 元」 / 「原价 299 元」 (§7).
 */
export function Price({
  value,
  size = 'md',
  strike,
  prefix,
  tone = 'price',
  className,
}: PriceProps) {
  const [whole, fraction] = splitMoney(value);
  const spoken = `${strike ? '原价' : (prefix ?? '价格')} ${whole}${fraction && fraction !== '.00' ? fraction : ''} 元`;
  return (
    <View
      className={cx(
        'shop-price',
        `shop-price--${size}`,
        strike && 'shop-price--strike',
        tone === 'text' && 'shop-price--text',
        className,
      )}
      ariaRole="text"
      ariaLabel={spoken}
    >
      {prefix && !strike ? <Text className="shop-price__prefix">{prefix}</Text> : null}
      <Text className="shop-price__symbol">¥</Text>
      <Text className="shop-price__whole">{whole}</Text>
      {fraction ? <Text className="shop-price__fraction">{fraction}</Text> : null}
    </View>
  );
}
