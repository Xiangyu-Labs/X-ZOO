import { View } from '@tarojs/components';
import type { ReactNode } from 'react';

import type { BlockStyle } from '@shop/contracts/decor/base';
import { cx } from './css';
import styles from './frame.module.scss';

const MARGIN_Y = { none: styles.myNone, sm: styles.mySm, md: styles.myMd, lg: styles.myLg };
const PADDING_X = { none: styles.pxNone, sm: styles.pxSm, md: styles.pxMd, lg: styles.pxLg };
const RADIUS = { none: styles.radiusNone, sm: styles.radiusSm, lg: styles.radiusLg };

export interface BlockFrameProps {
  /** Rendered as `data-block`, which tests and the fidelity script select on. */
  type: string;
  frame: BlockStyle;
  className?: string | undefined;
  /** On the outer element, which spans the page width (a sticky block). */
  outerClassName?: string | undefined;
  children: ReactNode;
}

/** The shared spacing, background and corner radius around every block. */
export function BlockFrame({ type, frame, className, outerClassName, children }: BlockFrameProps) {
  return (
    <View
      data-block={type}
      className={cx(
        styles.outer,
        MARGIN_Y[frame.marginY],
        PADDING_X[frame.paddingX],
        outerClassName,
      )}
    >
      <View
        className={cx(styles.inner, RADIUS[frame.radius], className)}
        {...(frame.background ? { style: { backgroundColor: frame.background } } : {})}
      >
        {children}
      </View>
    </View>
  );
}
