'use client';

import { DatePicker, Space, Tag } from 'antd';
import dayjs from 'dayjs';

import { presetWindow, RANGE_PRESETS, type StatsRange } from './use-stats-range';

/**
 * 时间范围. Presets plus a range picker, both writing the same two URL keys.
 *
 * The bucket is *not* offered: it is derived from the window's length by the
 * server (≤2 days → hour, ≤92 → day, else month). A quarter bucketed daily
 * would draw every third label over a daily series, quietly dropping two thirds
 * of the data.
 */
export function StatsRangePicker({ range }: { range: StatsRange }) {
  const active = (days: number): boolean => {
    if (!range.value) return false;
    const [from, to] = presetWindow(days);
    return range.value[0].isSame(from, 'day') && range.value[1].isSame(to, 'day');
  };

  return (
    <Space wrap size={[8, 8]}>
      {RANGE_PRESETS.map((preset) => (
        <Tag.CheckableTag
          key={preset.label}
          checked={active(preset.days)}
          onChange={(checked) => range.set(checked ? presetWindow(preset.days) : null)}
        >
          {preset.label}
        </Tag.CheckableTag>
      ))}
      <DatePicker.RangePicker
        allowClear
        value={range.value}
        // Three years is the server's limit (`MAX_RANGE_DAYS`); refusing here
        // is friendlier than a 422, and the 422 still exists behind it.
        disabledDate={(current) =>
          current.isAfter(dayjs(), 'day') || current.isBefore(dayjs().subtract(3, 'year'), 'day')
        }
        onChange={(value) => range.set(value?.[0] && value[1] ? [value[0], value[1]] : null)}
      />
    </Space>
  );
}
