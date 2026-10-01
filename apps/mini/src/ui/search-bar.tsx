import { Input, Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Icon } from './icon';
import { Pressable } from './pressable';
import './search-bar.scss';

interface Common {
  placeholder?: string | undefined;
  /** On a coloured header (home): a white field. */
  onColor?: boolean | undefined;
  className?: string | undefined;
}

export interface SearchEntryProps extends Common {
  /** A read-only entry (home, category): tapping opens the search page. */
  onOpen: () => void;
}

export interface SearchInputProps extends Common {
  value: string;
  onChange: (value: string) => void;
  onSearch: (value: string) => void;
  autoFocus?: boolean | undefined;
}

/** The search page's field: type, clear, 搜索 (design.md §4.3). */
export function SearchBar(props: SearchEntryProps | SearchInputProps) {
  const { placeholder = '搜索商品', onColor, className } = props;
  if ('onOpen' in props) {
    return (
      <View className={cx('shop-search', onColor && 'shop-search--on-color', className)}>
        <Pressable
          label={placeholder}
          role="link"
          className="shop-search__field"
          onClick={props.onOpen}
        >
          <Icon name="search" className="shop-search__icon" />
          <Text className="shop-search__placeholder">{placeholder}</Text>
        </Pressable>
      </View>
    );
  }
  const { value, onChange, onSearch, autoFocus } = props;
  return (
    <View className={cx('shop-search', onColor && 'shop-search--on-color', className)}>
      <View className="shop-search__field">
        <Icon name="search" className="shop-search__icon" />
        <Input
          className="shop-search__input"
          placeholderClass="shop-search__placeholder"
          value={value}
          placeholder={placeholder}
          focus={autoFocus ?? false}
          confirmType="search"
          ariaLabel={placeholder}
          onInput={(event) => onChange(event.detail.value)}
          onConfirm={(event) => onSearch(event.detail.value.trim())}
        />
        {/* Hidden rather than removed: removing it sends the row again, the focused input
            with it, and some Android phones drop the keyboard (see `Field`). */}
        <Pressable
          label="清除"
          hidden={value === ''}
          className={cx('shop-search__clear', value === '' && 'shop-search__clear--hidden')}
          onClick={() => onChange('')}
        >
          <Icon name="close-circle" />
        </Pressable>
      </View>
      <Pressable
        label="搜索"
        className="shop-search__submit"
        pressedTint={false}
        onClick={() => onSearch(value.trim())}
      >
        搜索
      </Pressable>
    </View>
  );
}
