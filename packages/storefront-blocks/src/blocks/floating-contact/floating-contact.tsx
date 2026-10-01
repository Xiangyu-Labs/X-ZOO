import { Image, Text, View } from '@tarojs/components';
import type { ReactNode } from 'react';

import type { FloatingContactProps } from '@shop/contracts/decor/all-blocks';
import { cx, designVars, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import { ICONS } from '../shared/icons';
import type { BlockIntent, BlockProps } from '../shared/types';
import styles from './floating-contact.module.scss';

const CONTACT: BlockIntent = { kind: 'contact' };

/**
 * 悬浮客服: a round button fixed to the left or right edge, `bottom` design px
 * up, that asks the host for `contact` — through `renderIntent` when the host
 * gives it (WeChat's `<button open-type="contact">`), else as a tap. A host
 * whose shop has no 客服 returns `null` from `renderIntent`, and the button is
 * not drawn at all.
 *
 * In the editor it sits in the flow, where it can be selected, with a note of
 * where it will float.
 */
export function FloatingContact({
  props,
  onIntent,
  renderIntent,
  host,
}: BlockProps<FloatingContactProps>) {
  const face: ReactNode = (
    <View className={styles.face}>
      <Image className={styles.icon} src={ICONS.contact} mode="aspectFit" />
      {props.label ? <Text className={styles.label}>{props.label}</Text> : null}
    </View>
  );
  if (host?.canvas) {
    return (
      <BlockFrame type="floatingContact" frame={props.style} className={styles.canvas}>
        <View className={cx(styles.button, styles.inline)}>{face}</View>
        <Text className={styles.note}>
          悬浮在页面{props.side === 'left' ? '左' : '右'}侧，距底部 {props.bottom}
        </Text>
      </BlockFrame>
    );
  }
  const wrapped = renderIntent ? renderIntent(CONTACT, face) : face;
  if (wrapped === null || wrapped === undefined || wrapped === false) return null;
  return (
    <View data-block="floatingContact" className={styles.anchor}>
      <View
        className={cx(
          styles.button,
          styles.fixed,
          props.side === 'left' ? styles.left : styles.right,
        )}
        style={designVars({ bottom: props.bottom })}
        data-intent="contact"
        {...(renderIntent ? {} : tapProps(onIntent ? () => onIntent(CONTACT) : undefined))}
      >
        {wrapped}
      </View>
    </View>
  );
}
