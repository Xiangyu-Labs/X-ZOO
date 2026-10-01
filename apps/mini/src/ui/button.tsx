import { useRef, useState, type ReactNode } from 'react';
import { Button as TaroButton, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import './button.scss';

export type ButtonVariant =
  'primary' | 'secondary' | 'soft' | 'outline' | 'outline-primary' | 'text' | 'danger';
export type ButtonSize = 'lg' | 'md' | 'sm';

export interface ButtonLook {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  block?: boolean | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  className?: string | undefined;
}

/**
 * The button classes, for the few buttons the platform layer renders itself (the phone-number
 * and avatar buttons, whose open-types only `src/platform` may use).
 */
export function buttonClassName({
  variant = 'primary',
  size = 'md',
  block = false,
  disabled = false,
  loading = false,
  className,
}: ButtonLook): string {
  return cx(
    'shop-btn',
    `shop-btn--${variant}`,
    `shop-btn--${size}`,
    block && 'shop-btn--block',
    disabled && 'shop-btn--disabled',
    loading && 'shop-btn--loading',
    className,
  );
}

export interface ButtonProps extends ButtonLook {
  children?: ReactNode;
  /** Return the promise of an async action: the button stays busy until it settles. */
  onClick?: (() => void | Promise<unknown>) | undefined;
  /** For icon-only buttons, or when the text alone would be unclear to a screen reader. */
  label?: string | undefined;
  /** Open-types the kit may use; phone number and avatar go through `@/platform`. */
  openType?: 'contact' | 'share' | 'feedback' | undefined;
  /** `open-type="contact"`: the customer-service session source (C15). */
  sessionFrom?: string | undefined;
  id?: string | undefined;
}

/**
 * H5 only: `role="button"`, for every button the kit draws (spread it on a raw Taro `Button`). Taro draws a button as `<taro-button-core>` there, which has no
 * implicit role, so assistive tech (and `getByRole('button')` in the e2e suite) did not see one.
 * WeChat's native `<button>` has its own, so the weapp build spreads nothing (the condition is a
 * build-time constant) and its output is unchanged. A plain `role` attribute on purpose: Taro's
 * H5 wrapper passes a string prop through as an attribute of the same name.
 */
export const H5_BUTTON_ROLE: { role?: 'button' } =
  process.env.TARO_ENV === 'h5' ? { role: 'button' } : {};

/**
 * `variant`: `primary` (one per page), `secondary` (accent), `soft`, `outline`,
 * `outline-primary`, `text`, `danger`. `size`: `lg` 88 / `md` 72 / `sm` 56. While `loading`,
 * the label keeps its width under a spinner and taps are ignored (no double submit).
 *
 * An `onClick` that returns a promise keeps the button loading until it settles. A caller's own
 * `loading={mutation.isPending}` is not enough: TanStack sets `isPending` on a later tick, so a
 * quick second tap lands before the re-render. The ref drops it synchronously.
 */
export function Button({
  children,
  onClick,
  label,
  openType,
  sessionFrom,
  id,
  ...look
}: ButtonProps) {
  const running = useRef(false);
  const [settling, setSettling] = useState(false);
  const loading = Boolean(look.loading) || settling;
  const inert = Boolean(look.disabled) || loading;

  const tap = () => {
    if (!onClick || running.current) return;
    const result = onClick();
    if (!(result instanceof Promise)) return;
    running.current = true;
    setSettling(true);
    const done = () => {
      running.current = false;
      setSettling(false);
    };
    // The caller shows its own error; one it did not catch still reaches the console.
    result.then(done, (error: unknown) => {
      done();
      console.error(error);
    });
  };

  return (
    <TaroButton
      {...(id ? { id } : {})}
      className={buttonClassName({ ...look, loading })}
      {...H5_BUTTON_ROLE}
      hoverClass={inert ? 'none' : 'shop-btn--pressed'}
      {...(openType && !inert ? { openType } : {})}
      {...(sessionFrom ? { sessionFrom } : {})}
      {...(label ? { ariaLabel: label } : {})}
      {...(inert ? { ariaDisabled: true } : {})}
      {...(inert || !onClick ? {} : { onClick: tap })}
    >
      <View className="shop-btn__label">{children}</View>
      {loading ? (
        <View className="shop-btn__spinner">
          <View className="shop-spinner" />
        </View>
      ) : null}
    </TaroButton>
  );
}
