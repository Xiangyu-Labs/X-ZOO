import { View } from '@tarojs/components';

import type { HotspotImageProps } from '@shop/contracts/decor/all-blocks';
import { BlockImage } from '../shared/block-image';
import { tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import type { BlockProps } from '../shared/types';
import styles from './hotspot-image.module.scss';

/** `12.5` → `"12.5%"`: a hotspot's box is in percent, so it needs no px transform. */
const pct = (value: number) => `${Math.round(value * 1000) / 1000}%`;

/**
 * 热区图: the picture at full width (its own ratio), with invisible tap areas
 * laid over it in percent of its size — the same spots at any screen width.
 * It loads lazily; WeChat starts it a few screens ahead of the viewport.
 */
export function HotspotImage({ props, onLink, host }: BlockProps<HotspotImageProps>) {
  return (
    <BlockFrame type="hotspotImage" frame={props.style}>
      <View className={styles.stage}>
        <BlockImage
          className={styles.image}
          src={props.image}
          width={960}
          resolve={host?.resolveImage}
          mode="widthFix"
          lazyLoad={!host?.canvas}
        />
        {props.hotspots.map((spot, index) => {
          const link = spot.link;
          return (
            <View
              key={index}
              className={styles.spot}
              style={{
                left: pct(spot.x),
                top: pct(spot.y),
                width: pct(spot.w),
                height: pct(spot.h),
              }}
              {...(spot.label ? { ariaLabel: spot.label } : {})}
              {...tapProps(onLink ? () => onLink(link) : undefined)}
            />
          );
        })}
      </View>
    </BlockFrame>
  );
}
