import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '@/test/render';

import { pickerToInstant } from '../instant';
import { DateField, rangePresets } from './date-fields';

/** Opens the picker, clicks the 15th of the shown month, then 确定. */
async function pickFifteenth(container: HTMLElement) {
  fireEvent.mouseDown(container.querySelector('input')!);
  fireEvent.click(container.querySelector('input')!);
  const cell = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      'td.ant-picker-cell-in-view[title$="-15"] .ant-picker-cell-inner',
    );
    expect(found).not.toBeNull();
    return found!;
  });
  fireEvent.click(cell);
  fireEvent.click(await screen.findByRole('button', { name: /确\s*定|OK/ }));
}

describe('DateField', () => {
  it('a 结束时间 with a time (拼团/预售 endAt) starts at 23:59:59 of the picked Shanghai day', async () => {
    const onChange = vi.fn();
    const { container } = renderAdmin(<DateField showTime endOfDay onChange={onChange} />);
    await pickFifteenth(container);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)?.[0]).toMatch(/-15T23:59:59\+08:00$/);
  });

  it('a start time keeps the time the picker opened with, not 23:59:59', async () => {
    const onChange = vi.fn();
    const { container } = renderAdmin(<DateField showTime onChange={onChange} />);
    await pickFifteenth(container);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)?.[0]).not.toMatch(/T23:59:59/);
  });
});

describe('rangePresets', () => {
  afterEach(() => vi.useRealTimers());

  function asInstants(label: string) {
    const preset = rangePresets().find((entry) => entry.label === label);
    return [
      pickerToInstant(preset?.value[0], 'startOfDay'),
      pickerToInstant(preset?.value[1], 'endOfDay'),
    ];
  }

  it('counts Shanghai days: 00:30 on 10-01 in Shanghai is still 9-30 in UTC', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T16:30:00Z'));

    expect(asInstants('今天')).toEqual(['2026-10-01T00:00:00+08:00', '2026-10-01T23:59:59+08:00']);
    expect(asInstants('昨天')).toEqual(['2026-09-30T00:00:00+08:00', '2026-09-30T23:59:59+08:00']);
    expect(asInstants('近 7 天')).toEqual([
      '2026-09-25T00:00:00+08:00',
      '2026-10-01T23:59:59+08:00',
    ]);
    expect(asInstants('上月')).toEqual(['2026-09-01T00:00:00+08:00', '2026-09-30T23:59:59+08:00']);
  });
});
