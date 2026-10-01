import { useState } from 'react';
import { Input, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Icon } from './icon';
import { Pressable } from './pressable';
import './stepper.scss';

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number | undefined;
  /** Stock, or the purchase limit, whichever is lower. */
  max?: number | undefined;
  disabled?: boolean | undefined;
  /** What the number is, for a screen reader: 「数量」. */
  label?: string | undefined;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * 减 · 数量 · 加 (design.md §4.3). The buttons disable at the limits; a typed number is
 * clamped when the input loses focus.
 *
 * The number is plain text until the shopper taps it; only then is it an input, focused. An
 * input that is always there takes the tap that opened its sheet: on Android the tap on
 * 立即购买 fell through to the stepper sliding in under the finger, and up came the keyboard.
 */
export function Stepper({
  value,
  onChange,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
  disabled,
  label = '数量',
}: StepperProps) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  const [editing, setEditing] = useState(false);
  if (shown !== value) {
    // The value changed from outside (a button, the server): show it.
    setShown(value);
    setDraft(String(value));
  }
  if (editing && disabled) {
    // Disabled mid-edit (a sold-out spec picked): back to text, or enabling it again would
    // bring the keyboard back up on its own.
    setEditing(false);
  }
  const atMin = disabled || value <= min;
  const atMax = disabled || value >= max;

  return (
    <View className={cx('shop-stepper', disabled && 'shop-stepper--disabled')}>
      <Pressable
        label={`减少${label}`}
        disabled={atMin}
        className="shop-stepper__button"
        onClick={() => onChange(clamp(value - 1, min, max))}
      >
        <Icon name="minus" />
      </Pressable>
      {editing ? (
        <Input
          className="shop-stepper__input"
          type="number"
          focus
          value={draft}
          ariaLabel={label}
          onInput={(event) => setDraft(event.detail.value)}
          onBlur={(event) => {
            const typed = Number.parseInt(event.detail.value, 10);
            const next = Number.isNaN(typed) ? value : clamp(typed, min, max);
            setDraft(String(next));
            setEditing(false);
            if (next !== value) onChange(next);
          }}
        />
      ) : (
        <Pressable
          label={`${label} ${value}，点按输入`}
          disabled={disabled}
          pressedTint={false}
          className="shop-stepper__input shop-stepper__value"
          onClick={() => setEditing(true)}
        >
          {draft}
        </Pressable>
      )}
      <Pressable
        label={`增加${label}`}
        disabled={atMax}
        className="shop-stepper__button"
        onClick={() => onChange(clamp(value + 1, min, max))}
      >
        <Icon name="plus" />
      </Pressable>
    </View>
  );
}
