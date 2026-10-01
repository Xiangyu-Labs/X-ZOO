import dayjs, { type Dayjs } from 'dayjs';
import 'dayjs/locale/zh-cn';
import relativeTime from 'dayjs/plugin/relativeTime';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

/**
 * The shop is single-region. Instants travel as ISO-8601 with offset and are
 * always *displayed* in Asia/Shanghai, whatever the operator's browser says —
 * an order timestamp must read the same to everyone looking at it.
 */
export const DISPLAY_TZ = 'Asia/Shanghai';

export type InstantFormat = 'datetime' | 'date' | 'time' | 'minute' | 'relative';

const PATTERNS: Record<Exclude<InstantFormat, 'relative'>, string> = {
  datetime: 'YYYY-MM-DD HH:mm:ss',
  minute: 'YYYY-MM-DD HH:mm',
  date: 'YYYY-MM-DD',
  time: 'HH:mm:ss',
};

/** Parses an ISO instant into a dayjs in the display timezone. */
export function toDisplayDayjs(value: string | Date | Dayjs | null | undefined): Dayjs | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.tz(DISPLAY_TZ) : null;
}

/** `"2026-03-01T10:00:00+08:00"` → `"2026-03-01 10:00:00"`. `"—"` when absent. */
export function formatInstant(
  value: string | Date | Dayjs | null | undefined,
  format: InstantFormat = 'datetime',
  placeholder = '—',
): string {
  const d = toDisplayDayjs(value);
  if (!d) return placeholder;
  return format === 'relative' ? d.fromNow() : d.format(PATTERNS[format]);
}

/**
 * Form value → wire value. Keeps the picker's own offset rather than forcing
 * UTC, so `2026-03-01 00:00` typed in Shanghai stays `+08:00`.
 */
export function toInstant(value: Dayjs | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const d = dayjs(value);
  if (!d.isValid()) return undefined;
  return d.tz(DISPLAY_TZ).format('YYYY-MM-DDTHH:mm:ssZ');
}

/**
 * Picker value → wire value, reading the date and time the operator *saw* as
 * Shanghai time.
 *
 * antd hands back a dayjs in the browser's zone: a date picked on a laptop set
 * to UTC is that day's 00:00 UTC, which `toInstant` would turn into 08:00 in
 * Shanghai. The shop's days are Shanghai days whatever the laptop says, so the
 * wall clock is taken as it stands and placed in Shanghai.
 *
 * `snap` moves it to the first or last second of its day: an end date a person
 * picks means the end of that day (至 9 月 30 日 includes the 30th).
 */
export function pickerToInstant(
  value: Dayjs | null | undefined,
  snap?: 'startOfDay' | 'endOfDay' | undefined,
): string | undefined {
  if (!value || !value.isValid()) return undefined;
  const day = value.format('YYYY-MM-DD');
  const time =
    snap === 'startOfDay'
      ? '00:00:00'
      : snap === 'endOfDay'
        ? '23:59:59'
        : value.format('HH:mm:ss');
  return dayjs.tz(`${day}T${time}`, DISPLAY_TZ).format('YYYY-MM-DDTHH:mm:ssZ');
}

/**
 * Whether a date field is the end of a window — 结束时间, 有效期至, 领取截止 —
 * by its contract name. Such a field defaults to 23:59:59 of the picked day.
 */
export function isEndOfWindow(name: string | readonly (string | number)[]): boolean {
  const last = typeof name === 'string' ? name.split('.').at(-1) : name.at(-1);
  return (
    typeof last === 'string' && /^(end|expire)|(To|End|EndAt|EndsAt|Until|Deadline)$/.test(last)
  );
}

/** Wire value → picker value. */
export function fromInstant(value: string | null | undefined): Dayjs | null {
  return toDisplayDayjs(value);
}

export { dayjs };
export type { Dayjs };
