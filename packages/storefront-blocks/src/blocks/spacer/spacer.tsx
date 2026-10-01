import { View } from '@tarojs/components';

import type { SpacerProps } from '@shop/contracts/decor/all-blocks';
import { cx, designVars } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import type { BlockProps } from '../shared/types';
import styles from './spacer.module.scss';

/** 间隔 / 分割线: blank space of the chosen height, with an optional rule through its middle. */
export function Spacer({ props }: BlockProps<SpacerProps>) {
  return (
    <BlockFrame type="spacer" frame={props.style}>
      <View className={styles.space} style={designVars({ height: props.height })}>
        {props.line === 'none' ? null : (
          <View
            className={cx(
              styles.line,
              props.line === 'dashed' && styles.dashed,
              props.inset && styles.inset,
            )}
            {...(props.lineColor ? { style: { borderTopColor: props.lineColor } } : {})}
          />
        )}
      </View>
    </BlockFrame>
  );
}
