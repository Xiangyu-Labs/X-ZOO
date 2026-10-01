import { useRef, type ReactNode } from 'react';
import { View } from '@tarojs/components';
import { cx } from '@/lib/cx';

export interface PressableProps {
  /** What a screen reader announces. Required: a tappable thing always has a name (§7). */
  label: string;
  /** Return the promise of an async action: taps are ignored until it settles (no double submit). */
  onClick?: (() => void | Promise<unknown>) | undefined;
  disabled?: boolean | undefined;
  /** `button` by default; `link` for navigation rows, `tab`, `checkbox`, `radio`… */
  role?: 'button' | 'link' | 'tab' | 'checkbox' | 'radio' | 'switch' | undefined;
  selected?: boolean | undefined;
  checked?: boolean | undefined;
  /** The pressed tint (5% black). Off for things that show their own pressed state. */
  pressedTint?: boolean | undefined;
  /** A control inside another tappable thing (加购 on a card): the tap stops here. */
  stopPropagation?: boolean | undefined;
  /**
   * Out of the way, but still in the tree: no tap, not announced. The caller's class hides it
   * (`display: none`). For a control that comes and goes beside an input as the shopper types,
   * where adding or removing a node would send the focused input again (see `Field`).
   */
  hidden?: boolean | undefined;
  className?: string | undefined;
  id?: string | undefined;
  children?: ReactNode;
}

/**
 * The one way to make a `View` tappable (docs/mini/design.md §7): it carries a role and a name
 * for VoiceOver / TalkBack and the kit's pressed state (`hover-class`). Pages never put
 * `onClick` on a bare `View`.
 */
export function Pressable({
  label,
  onClick,
  disabled = false,
  role = 'button',
  selected,
  checked,
  pressedTint = true,
  stopPropagation = false,
  hidden = false,
  className,
  id,
  children,
}: PressableProps) {
  const running = useRef(false);
  const tap = () => {
    if (!onClick || running.current) return;
    const result = onClick();
    if (!(result instanceof Promise)) return;
    running.current = true;
    // The caller shows its own error; one it did not catch still reaches the console.
    result.then(
      () => {
        running.current = false;
      },
      (error: unknown) => {
        running.current = false;
        console.error(error);
      },
    );
  };
  return (
    <View
      {...(id ? { id } : {})}
      className={cx('shop-pressable', disabled && 'shop-pressable--disabled', className)}
      hoverClass={disabled || !pressedTint ? 'none' : 'shop-pressed'}
      hoverStayTime={100}
      ariaRole={role}
      ariaLabel={label}
      {...(hidden ? { ariaHidden: true } : {})}
      {...(disabled ? { ariaDisabled: true } : {})}
      {...(selected === undefined ? {} : { ariaSelected: selected })}
      {...(checked === undefined ? {} : { ariaChecked: checked })}
      {...(disabled || hidden || !onClick
        ? {}
        : {
            onClick: (event: { stopPropagation: () => void }) => {
              if (stopPropagation) event.stopPropagation();
              tap();
            },
          })}
    >
      {children}
    </View>
  );
}
