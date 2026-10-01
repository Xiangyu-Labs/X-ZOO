import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Icon } from './icon';
import { Pressable } from './pressable';
import './choice.scss';

interface ChoiceProps {
  checked: boolean;
  /** Return the change's promise: taps are ignored until it settles (AGENTS 17). */
  onChange?: ((checked: boolean) => void | Promise<unknown>) | undefined;
  disabled?: boolean | undefined;
  /** What a screen reader says; shown beside the mark unless `children` replaces it. */
  label: string;
  /** Visible content instead of `label` (the label is still what is announced). */
  children?: ReactNode;
  className?: string | undefined;
}

function Mark({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  return (
    <View
      className={cx('shop-choice__mark', (checked || indeterminate) && 'shop-choice__mark--on')}
    >
      {indeterminate ? <Icon name="minus" /> : checked ? <Icon name="check" /> : null}
    </View>
  );
}

/**
 * A round checkbox (40, hit area 88; design.md §4.3). `indeterminate` for a 全选 that is partly
 * on. Selection shows a tick, not only colour (§7).
 */
export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  children,
  indeterminate,
  className,
}: ChoiceProps & { indeterminate?: boolean | undefined }) {
  return (
    <Pressable
      role="checkbox"
      label={label}
      checked={checked}
      disabled={disabled}
      pressedTint={false}
      className={cx('shop-choice', disabled && 'shop-choice--disabled', className)}
      onClick={() => onChange?.(!checked)}
    >
      <Mark checked={checked} indeterminate={indeterminate ?? false} />
      {children ?? <Text className="shop-choice__label">{label}</Text>}
    </Pressable>
  );
}

/** A radio: like `Checkbox`, but tapping a checked one does nothing. */
export function Radio({ checked, onChange, disabled, label, children, className }: ChoiceProps) {
  return (
    <Pressable
      role="radio"
      label={label}
      checked={checked}
      disabled={disabled}
      pressedTint={false}
      className={cx('shop-choice', disabled && 'shop-choice--disabled', className)}
      onClick={() => (checked ? undefined : onChange?.(true))}
    >
      <Mark checked={checked} />
      {children ?? <Text className="shop-choice__label">{label}</Text>}
    </Pressable>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean | undefined;
  /** The server is saving the change: the knob spins and taps wait. */
  loading?: boolean | undefined;
}

/** An on/off switch for settings rows (design.md §4.3). */
export function Switch({ checked, onChange, label, disabled, loading }: SwitchProps) {
  return (
    <Pressable
      role="switch"
      label={label}
      checked={checked}
      disabled={disabled || loading}
      pressedTint={false}
      className={cx(
        'shop-switch',
        checked && 'shop-switch--on',
        disabled && 'shop-switch--disabled',
      )}
      onClick={() => onChange(!checked)}
    >
      <View className="shop-switch__knob">
        {loading ? <View className="shop-spinner shop-switch__spinner" /> : null}
      </View>
    </Pressable>
  );
}
