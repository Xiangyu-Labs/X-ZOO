import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { dayjs } from '@/admin/kit/instant';
import type { TableUrlState } from '@/admin/kit/table/url-state';

import { useStatsRange } from './use-stats-range';

function createMemoryUrlState(): {
  state: TableUrlState;
  written: Record<string, string | undefined>[];
} {
  const store = new Map<string, string>();
  const written: Record<string, string | undefined>[] = [];
  const state: TableUrlState = {
    read: (key) => store.get(key),
    write: (patch) => {
      written.push(patch);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) store.delete(k);
        else store.set(k, v);
      }
    },
  };
  return { state, written };
}

describe('useStatsRange', () => {
  it('keeps the picked calendar day in Asia/Shanghai even when the picker dayjs is in UTC+10', () => {
    const { state, written } = createMemoryUrlState();
    const { result } = renderHook(() => useStatsRange(state));

    // A laptop in Sydney (UTC+10) picks 2026-11-17: 00:00+10:00 is 2026-11-16 22:00+08:00.
    // Using `.tz('Asia/Shanghai')` directly would snap to 2026-11-16; `pickerToInstant` keeps 2026-11-17.
    const sydneyDay = dayjs('2026-11-17T00:00:00+10:00').utcOffset(600);
    act(() => {
      result.current.set([sydneyDay, sydneyDay]);
    });

    expect(written.at(-1)).toEqual({
      from: '2026-11-17T00:00:00+08:00',
      to: '2026-11-17T23:59:59+08:00',
    });
  });
});
