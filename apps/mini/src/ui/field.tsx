import { useState, type ReactNode } from 'react';
import { Input, Text, Textarea as TaroTextarea, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Icon } from './icon';
import { Pressable } from './pressable';
import './field.scss';

export type FieldType = 'text' | 'number' | 'digit' | 'idcard' | 'nickname' | 'tel';

export interface FieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The row's label (left, 160 wide). Leave out for a bare input. */
  label?: string | undefined;
  placeholder?: string | undefined;
  /** `tel` is a `number` keyboard capped at 11 digits. */
  type?: FieldType | undefined;
  password?: boolean | undefined;
  maxLength?: number | undefined;
  /** 「3/20」 under the input. */
  showCount?: boolean | undefined;
  /** The clear button while there is text and the field has focus. Default on. */
  clearable?: boolean | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  /** A message under the row, in red text. */
  error?: string | undefined;
  /** Something after the input: a unit, a 「获取验证码」 button. */
  suffix?: ReactNode;
  focus?: boolean | undefined;
  confirmType?: 'done' | 'next' | 'search' | 'send' | 'go' | undefined;
  onBlur?: ((value: string) => void) | undefined;
  onConfirm?: ((value: string) => void) | undefined;
  className?: string | undefined;
  id?: string | undefined;
}

function taroType(type: FieldType): 'text' | 'number' | 'digit' | 'idcard' | 'nickname' {
  return type === 'tel' ? 'number' : type;
}

/**
 * A text input row (design.md §4.3): label, input, clear, suffix, count, error. The keyboard
 * pushes the page up (`adjust-position`); a fixed submit bar stays where it is.
 */
export function Field({
  value,
  onChange,
  label,
  placeholder,
  type = 'text',
  password,
  maxLength,
  showCount,
  clearable = true,
  required,
  disabled,
  readOnly,
  error,
  suffix,
  focus,
  confirmType,
  onBlur,
  onConfirm,
  className,
  id,
}: FieldProps) {
  const [focused, setFocused] = useState(false);
  const limit = maxLength ?? (type === 'tel' ? 11 : 140);
  const inert = disabled || readOnly;
  return (
    <View
      className={cx(
        'shop-field',
        focused && 'shop-field--focused',
        error && 'shop-field--error',
        disabled && 'shop-field--disabled',
        className,
      )}
    >
      <View className="shop-field__row">
        {label ? (
          <Text className="shop-field__label">
            {required ? (
              <Text className="shop-field__required" ariaHidden>
                *
              </Text>
            ) : null}
            {label}
          </Text>
        ) : null}
        <Input
          {...(id ? { id } : {})}
          className="shop-field__input"
          placeholderClass="shop-field__placeholder"
          value={value}
          type={taroType(type)}
          password={password ?? false}
          maxlength={limit}
          placeholder={placeholder ?? ''}
          disabled={inert ?? false}
          focus={focus ?? false}
          confirmType={confirmType ?? 'done'}
          adjustPosition
          ariaLabel={label ?? placeholder ?? ''}
          onInput={(event) => onChange(event.detail.value)}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event.detail.value);
          }}
          onConfirm={(event) => onConfirm?.(event.detail.value)}
        />
        {/* Always rendered, hidden by a class: a node inserted or removed in this row makes
            Taro send the whole row again (`updateChildNodes`), the input with it, and some
            Android phones then drop the keyboard. Typing the first character would do it. */}
        {clearable && !inert ? (
          <Pressable
            label="清除"
            hidden={!(focused && value !== '')}
            className={cx(
              'shop-field__clear',
              !(focused && value !== '') && 'shop-field__clear--hidden',
            )}
            onClick={() => onChange('')}
          >
            <Icon name="close-circle" />
          </Pressable>
        ) : null}
        {suffix ? <View className="shop-field__suffix">{suffix}</View> : null}
      </View>
      {showCount ? (
        <Text className="shop-field__count">
          {value.length}/{limit}
        </Text>
      ) : null}
      {/* Always rendered, like the clear button: clearing the error as the shopper types must
          not send the row (and the focused input) again. */}
      <Text className={cx('shop-field__error', !error && 'shop-field__error--hidden')}>
        {error ?? ''}
      </Text>
    </View>
  );
}

export interface TextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  /** Shown as a count 「12/200」. Default 200. */
  maxLength?: number | undefined;
  /** Grows with the text instead of a fixed 4 lines. */
  autoHeight?: boolean | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  /** What a screen reader calls it (there is no visible label). */
  label: string;
  className?: string | undefined;
}

/** Multi-line text (reviews, after-sale reasons) with a count (design.md §4.3). */
export function Textarea({
  value,
  onChange,
  placeholder,
  maxLength = 200,
  autoHeight,
  disabled,
  error,
  label,
  className,
}: TextareaProps) {
  return (
    <View className={cx('shop-textarea', error && 'shop-field--error', className)}>
      <TaroTextarea
        className="shop-textarea__input"
        placeholderClass="shop-field__placeholder"
        value={value}
        maxlength={maxLength}
        placeholder={placeholder ?? ''}
        disabled={disabled ?? false}
        autoHeight={autoHeight ?? false}
        ariaLabel={label}
        onInput={(event) => onChange(event.detail.value)}
      />
      <Text className="shop-textarea__count">
        {value.length}/{maxLength}
      </Text>
      {/* Always rendered, as in Field: the error appearing or clearing must not make Taro send
          the textarea again, which drops the keyboard mid-typing. */}
      <Text className={cx('shop-field__error', !error && 'shop-field__error--hidden')}>
        {error ?? ''}
      </Text>
    </View>
  );
}
