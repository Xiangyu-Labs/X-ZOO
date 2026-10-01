import { Image, ScrollView, Text, View } from '@tarojs/components';

import type { SearchBarProps } from '@shop/contracts/decor/all-blocks';
import { cx, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import { ICONS } from '../shared/icons';
import type { BlockProps } from '../shared/types';
import styles from './search-bar.module.scss';

/**
 * 搜索框: looks like a field, opens the search page. A hot word opens it with
 * that keyword. `sticky` keeps the block at the top while the page scrolls.
 */
export function SearchBar({ props, onLink }: BlockProps<SearchBarProps>) {
  const open = (keyword?: string) =>
    onLink?.({
      kind: 'route',
      to: { route: 'search', params: keyword === undefined ? {} : { keyword } },
    });
  return (
    <BlockFrame
      type="searchBar"
      frame={props.style}
      className={styles.body}
      outerClassName={props.sticky ? styles.sticky : undefined}
    >
      <View
        className={cx(styles.field, props.shape === 'round' ? styles.round : styles.square)}
        ariaLabel="搜索"
        {...tapProps(onLink ? () => open() : undefined)}
      >
        <Image className={styles.icon} src={ICONS.search} mode="aspectFit" />
        <Text className={styles.placeholder}>{props.placeholder}</Text>
      </View>
      {props.hotWords.length > 0 ? (
        <ScrollView className={styles.hot} scrollX>
          <View className={styles.hotTrack}>
            {props.hotWords.map((hot, index) => (
              <View
                key={index}
                className={styles.hit}
                {...tapProps(onLink ? () => open(hot.word) : undefined)}
              >
                <View className={styles.word}>{hot.word}</View>
              </View>
            ))}
          </View>
        </ScrollView>
      ) : null}
    </BlockFrame>
  );
}
