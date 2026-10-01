'use client';

import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useMemo } from 'react';

import { DISPLAY_TZ } from '@/admin/kit/instant';
import { useNextUrlState, type TableUrlState } from '@/admin/kit/table/url-state';

export interface StatsRange {
  /** What goes in the query. `undefined` on both ends means "the server's default". */
  query: { from?: string; to?: string };
  /** The same window as a picker value, or `null` while it is the default. */
  value: [Dayjs, Dayjs] | null;
  set: (next: [Dayjs, Dayjs] | null) => void;
}

/** The presets every statistics page offers, in the order operators expect. */
export const RANGE_PRESETS: { label: string; days: number }[] = [
  { label: '今天', days: 1 },
  { label: '昨天', days: -1 },
  { label: '最近7天', days: 7 },
  { label: '最近30天', days: 30 },
  { label: '最近90天', days: 90 },
];

/**
 * The window, held in the URL.
 *
 * In the URL so that a filtered chart is a link an operator can paste into a
 * message — the same reason `CrudTable` keeps paging and filters there. The
 * keys are `from` and `to` and they carry whole Shanghai days; the server
 * re-derives the window from them anyway and answers with the window it used,
 * so the page never has to guess what it is showing.
 */
export function useStatsRange(urlState?: TableUrlState): StatsRange {
  const fallback = useNextUrlState();
  const state = urlState ?? fallback;
  const from = state.read('from');
  const to = state.read('to');

  const set = useCallback(
    (next: [Dayjs, Dayjs] | null) => {
      if (!next) {
        state.write({ from: undefined, to: undefined });
        return;
      }
      state.write({
        from: next[0].tz(DISPLAY_TZ).startOf('day').toISOString(),
        to: next[1].tz(DISPLAY_TZ).endOf('day').toISOString(),
      });
    },
    [state],
  );

  return useMemo(() => {
    const parsedFrom = from ? dayjs(from) : null;
    const parsedTo = to ? dayjs(to) : null;
    const value: [Dayjs, Dayjs] | null =
      parsedFrom?.isValid() && parsedTo?.isValid()
        ? [parsedFrom.tz(DISPLAY_TZ), parsedTo.tz(DISPLAY_TZ)]
        : null;

    return {
      query: {
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      },
      value,
      set,
    };
  }, [from, to, set]);
}

/** `days` from `RANGE_PRESETS` → a window ending today (or, for `-1`, yesterday). */
export function presetWindow(days: number, now: Dayjs = dayjs()): [Dayjs, Dayjs] {
  const today = now.tz(DISPLAY_TZ).startOf('day');
  if (days === -1) return [today.subtract(1, 'day'), today.subtract(1, 'day')];
  return [today.subtract(days - 1, 'day'), today];
}
