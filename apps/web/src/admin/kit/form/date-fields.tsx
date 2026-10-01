'use client';

import { DatePicker } from 'antd';
import { useState } from 'react';

import { DISPLAY_TZ, dayjs, fromInstant, pickerToInstant, type Dayjs } from '../instant';
import { defined } from '../props';

export interface DateFieldProps {
  /** ISO-8601 instant with offset. `null` is a cleared picker. */
  value?: string | null | undefined;
  /**
   * `null` when the operator clears the picker, so a form can tell "cleared"
   * (send `null`, the explicit clear) from "never touched".
   */
  onChange?: (value: string | null) => void;
  showTime?: boolean | undefined;
  /**
   * The end of a window (结束时间, 有效期至): a picked day means its last second,
   * 23:59:59 — and with `showTime` that is the time offered first.
   */
  endOfDay?: boolean | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  style?: React.CSSProperties | undefined;
  id?: string | undefined;
  /** Predicate on the *display* dayjs; e.g. disallow past dates. */
  disabledDate?: ((current: Dayjs) => boolean) | undefined;
}

/**
 * Single date/time picker whose value is an ISO instant with offset, displayed
 * in Asia/Shanghai. Contracts never see a `Dayjs`.
 */
export function DateField({
  value,
  onChange,
  showTime = false,
  disabled,
  placeholder,
  style,
  id,
  disabledDate,
  endOfDay = false,
}: DateFieldProps) {
  return (
    <DatePicker
      {...defined({ id, disabled })}
      style={{ width: '100%', ...style }}
      showTime={showTime && endOfDay ? { defaultOpenValue: END_OF_DAY } : showTime}
      value={fromInstant(value)}
      placeholder={placeholder ?? (showTime ? '选择日期时间' : '选择日期')}
      {...(disabledDate ? { disabledDate } : {})}
      onChange={(next) =>
        onChange?.(
          pickerToInstant(next, showTime ? undefined : endOfDay ? 'endOfDay' : undefined) ?? null,
        )
      }
    />
  );
}

/** The time a picked end date starts with. Only its time of day is read. */
const END_OF_DAY = dayjs('2000-01-01T23:59:59');

export interface DateRangeFieldProps {
  /** `[startISO, endISO]`. */
  value?: [string, string] | undefined;
  onChange?: (value: [string, string] | undefined) => void;
  showTime?: boolean | undefined;
  disabled?: boolean | undefined;
  placeholder?: [string, string] | undefined;
  style?: React.CSSProperties | undefined;
  id?: string | undefined;
  /**
   * Snap the two ends to the start and end of their day. What you almost always
   * want for a "created between" filter. Ignored when `showTime`.
   */
  wholeDays?: boolean | undefined;
  /** 今天 / 近 7 天 / 本月 … shortcuts beside the calendar. Default on. */
  presets?: boolean | undefined;
}

/**
 * The shortcuts every range picker offers. Built when the picker opens, so
 * 今天 is today even in a tab left open overnight; the days are Shanghai's,
 * as wall-clock values that `pickerToInstant` reads back unchanged.
 */
export function rangePresets(): { label: string; value: [Dayjs, Dayjs] }[] {
  const today = dayjs(dayjs().tz(DISPLAY_TZ).format('YYYY-MM-DD'));
  const end = (day: Dayjs): Dayjs => day.endOf('day');
  const monthStart = today.startOf('month');
  const lastMonthStart = monthStart.subtract(1, 'month');
  return [
    { label: '今天', value: [today, end(today)] },
    { label: '昨天', value: [today.subtract(1, 'day'), end(today.subtract(1, 'day'))] },
    { label: '近 7 天', value: [today.subtract(6, 'day'), end(today)] },
    { label: '近 30 天', value: [today.subtract(29, 'day'), end(today)] },
    { label: '本月', value: [monthStart, end(today)] },
    { label: '上月', value: [lastMonthStart, end(monthStart.subtract(1, 'day'))] },
  ];
}

/** Range picker producing a `[startISO, endISO]` tuple. */
export function DateRangeField({
  value,
  onChange,
  showTime = false,
  disabled,
  placeholder = ['开始日期', '结束日期'],
  style,
  id,
  wholeDays = true,
  presets = true,
}: DateRangeFieldProps) {
  const [presetList, setPresetList] = useState<ReturnType<typeof rangePresets>>([]);
  const start = fromInstant(value?.[0]);
  const end = fromInstant(value?.[1]);

  return (
    <DatePicker.RangePicker
      {...defined({ id, disabled })}
      style={{ width: '100%', ...style }}
      showTime={showTime}
      placeholder={placeholder}
      value={start && end ? [start, end] : null}
      {...(presets
        ? {
            presets: presetList,
            onOpenChange: (open: boolean) => {
              if (open) setPresetList(rangePresets());
            },
          }
        : {})}
      onChange={(next) => {
        if (!next || !next[0] || !next[1]) {
          onChange?.(undefined);
          return;
        }
        const snap = wholeDays && !showTime;
        const from = pickerToInstant(next[0], snap ? 'startOfDay' : undefined);
        const to = pickerToInstant(next[1], snap ? 'endOfDay' : undefined);
        onChange?.(from && to ? [from, to] : undefined);
      }}
    />
  );
}
