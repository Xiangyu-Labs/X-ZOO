import { Text, View } from '@tarojs/components';

import type { TitleBarProps } from '@shop/contracts/decor/all-blocks';
import { cx, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import type { BlockProps } from '../shared/types';
import styles from './title-bar.module.scss';

/** 标题栏: a section heading; 「更多」 at the right only when it links somewhere. */
export function TitleBar({ props, onLink }: BlockProps<TitleBarProps>) {
  const more = props.moreLink;
  return (
    <BlockFrame type="titleBar" frame={props.style} className={styles.body}>
      <View className={cx(styles.bar, props.align === 'center' && styles.center)}>
        <View className={styles.heading}>
          <Text className={styles.title}>{props.title}</Text>
          {props.subtitle ? <Text className={styles.subtitle}>{props.subtitle}</Text> : null}
        </View>
        {more ? (
          <View className={styles.more} {...tapProps(onLink ? () => onLink(more) : undefined)}>
            <Text>{props.moreText || '更多'}</Text>
            <View className={styles.chevron} />
          </View>
        ) : null}
      </View>
    </BlockFrame>
  );
}
