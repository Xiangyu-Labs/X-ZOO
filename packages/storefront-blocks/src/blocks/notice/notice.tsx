import { Image, Swiper, SwiperItem, Text, View } from '@tarojs/components';

import type { NoticeLine, NoticeProps } from '@shop/contracts/decor/all-blocks';
import type { LinkTarget } from '@shop/contracts/decor/link';
import { cx, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import { ICONS } from '../shared/icons';
import type { BlockProps } from '../shared/types';
import styles from './notice.module.scss';

function Line({
  line,
  divided = false,
  onLink,
}: {
  line: NoticeLine;
  divided?: boolean;
  onLink: ((target: LinkTarget) => void) | undefined;
}) {
  const link = line.link;
  return (
    <View
      className={cx(styles.line, divided && styles.divided)}
      {...tapProps(link && onLink ? () => onLink(link) : undefined)}
    >
      <Text className={styles.text}>{line.text}</Text>
      {link ? <View className={styles.chevron} /> : null}
    </View>
  );
}

/**
 * 公告: a speaker, an optional label and the lines — rolling up one at a
 * time (`scroll`, never faster than every 4 s) or all listed (`static`).
 */
export function Notice({ props, onLink }: BlockProps<NoticeProps>) {
  const rolling = props.mode === 'scroll' && props.lines.length > 1;
  return (
    <BlockFrame type="notice" frame={props.style} className={styles.body}>
      <View className={cx(styles.bar, !rolling && props.lines.length > 1 && styles.stacked)}>
        <View className={styles.lead}>
          <Image className={styles.icon} src={ICONS.notice} mode="aspectFit" />
          {props.label ? <Text className={styles.label}>{props.label}</Text> : null}
        </View>
        {rolling ? (
          <Swiper className={styles.roll} vertical autoplay circular interval={props.interval}>
            {props.lines.map((line, index) => (
              <SwiperItem key={index}>
                <Line line={line} onLink={onLink} />
              </SwiperItem>
            ))}
          </Swiper>
        ) : (
          <View className={styles.list}>
            {props.lines.map((line, index) => (
              <Line key={index} line={line} divided={index > 0} onLink={onLink} />
            ))}
          </View>
        )}
      </View>
    </BlockFrame>
  );
}
