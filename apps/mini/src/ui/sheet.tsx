import type { ReactNode } from 'react';
import { View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Icon } from './icon';
import { Pressable } from './pressable';
import { usePresence } from './use-presence';
import './sheet.scss';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string | undefined;
  /** A fixed button row under the scrolling content, clear of the home indicator. */
  footer?: ReactNode;
  /** `auto` (fits the content, up to 85% of the screen) or `tall` (75%, for long lists). */
  height?: 'auto' | 'tall' | undefined;
  /** Padding around the body; off for full-bleed lists. */
  padded?: boolean | undefined;
  /** Tapping the mask closes; off for a choice that must be made (privacy). */
  dismissible?: boolean | undefined;
  /** The close (×) button; on unless the sheet must be answered. */
  closable?: boolean | undefined;
  className?: string | undefined;
  children?: ReactNode;
}

/**
 * A bottom sheet (design.md §1.2: choices come up from the bottom). Slides in over a fading
 * mask; while open the page behind does not scroll. `aria-modal`, and the close button is named.
 *
 * Nothing inside it takes a touch until it has slid in: the tap that opened it must not land on
 * what slides in under the finger (Android put the keyboard up for an input there).
 */
export function Sheet({
  visible,
  onClose,
  title,
  footer,
  height = 'auto',
  padded = true,
  dismissible = true,
  closable = true,
  className,
  children,
}: SheetProps) {
  const { mounted, shown, settled } = usePresence(visible);
  if (!mounted) return null;
  return (
    <>
      <View
        className={cx('shop-mask', shown && 'shop-mask--shown')}
        catchMove
        ariaHidden
        {...(dismissible ? { onClick: () => onClose() } : {})}
      />
      <View
        className={cx(
          'shop-sheet',
          shown && 'shop-sheet--shown',
          !settled && 'shop-sheet--entering',
          height === 'tall' && 'shop-sheet--tall',
          className,
        )}
        ariaRole="dialog"
        ariaModal
        {...(title ? { ariaLabel: title } : {})}
      >
        {title || closable ? (
          <View className="shop-sheet__header">
            {title ? <View className="shop-sheet__title">{title}</View> : null}
            {closable ? (
              <Pressable label="关闭" className="shop-sheet__close" onClick={onClose}>
                <Icon name="close" />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View className={cx('shop-sheet__body', padded && 'shop-sheet__body--padded')}>
          {children}
        </View>
        {footer ? (
          <View className="shop-sheet__footer">{footer}</View>
        ) : (
          <View className="shop-sheet__spacer" />
        )}
      </View>
    </>
  );
}
