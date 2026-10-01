import { useEffect, useRef, useState } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { serverNow } from '@/lib/server-clock';
import { onEverySecond, usePageShown } from './second-ticker';
import './countdown.scss';

export interface CountdownProps {
  /** The real deadline (ISO time from the server): a group's expiry, an unpaid order's. */
  endsAt: string;
  /** `hms` (02:15:09) or `dhms` (1天 02:15:09). Default `hms`, rolling days into hours. */
  format?: 'hms' | 'dhms' | undefined;
  /** Boxed digits (a detail page's hero) or plain text inline. */
  variant?: 'plain' | 'boxed' | undefined;
  /** Called once when it reaches zero. */
  onEnd?: (() => void) | undefined;
  /** What an ended countdown says. Default 「已结束」. */
  endedText?: string | undefined;
  className?: string | undefined;
}

export interface Remaining {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  total: number;
}

export function remainingUntil(endsAtMs: number, nowMs: number): Remaining {
  const total = Math.max(0, Math.floor((endsAtMs - nowMs) / 1000));
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
    total,
  };
}

const two = (value: number) => String(value).padStart(2, '0');

/**
 * Time left to a real deadline (C02, C16: no fake urgency), on the server's clock, not the
 * phone's (`lib/server-clock`). Ticks once a second on the shared ticker, only while its page is
 * showing (it catches up on show); says 「已结束」 at zero and stops ticking. A new `endsAt` (the
 * deadline moved) starts it again.
 */
export function Countdown({
  endsAt,
  format = 'hms',
  variant = 'plain',
  onEnd,
  endedText = '已结束',
  className,
}: CountdownProps) {
  const end = Date.parse(endsAt);
  const [left, setLeft] = useState(() => remainingUntil(end, serverNow()));
  const onEndRef = useRef(onEnd);
  useEffect(() => {
    onEndRef.current = onEnd;
  });
  const shown = usePageShown();
  // Whether `onEnd` is settled for this deadline. Kept across hide/show so a countdown that
  // reached zero while its page was hidden still says so on show; reset when `endsAt` moves.
  const settled = useRef<{ end: number; ended: boolean } | undefined>(undefined);

  useEffect(() => {
    if (settled.current?.end !== end) {
      // Already over when shown: nothing to count, and no `onEnd` (it did not reach zero here).
      settled.current = { end, ended: remainingUntil(end, serverNow()).total === 0 };
    }
    const state = settled.current;
    if (!shown) return;
    let stop: (() => void) | undefined;
    const tick = () => {
      const next = remainingUntil(end, serverNow());
      setLeft(next);
      if (next.total > 0) return;
      // At zero: stop ticking (a list of order cards would otherwise re-render every second
      // for as long as the page lives), and say so once.
      stop?.();
      stop = undefined;
      if (!state.ended) {
        state.ended = true;
        onEndRef.current?.();
      }
    };
    tick();
    if (!state.ended) stop = onEverySecond(tick);
    return () => stop?.();
  }, [end, shown]);

  if (left.total === 0) {
    return (
      <Text className={cx('shop-countdown', 'shop-countdown--ended', className)}>{endedText}</Text>
    );
  }
  const hours = format === 'dhms' ? left.hours : left.days * 24 + left.hours;
  const parts = [two(hours), two(left.minutes), two(left.seconds)];
  const spoken = `剩余${format === 'dhms' && left.days > 0 ? `${left.days}天` : ''}${hours}小时${left.minutes}分${left.seconds}秒`;
  return (
    <View
      className={cx('shop-countdown', `shop-countdown--${variant}`, className)}
      ariaRole="timer"
      ariaLabel={spoken}
    >
      {format === 'dhms' && left.days > 0 ? (
        <Text className="shop-countdown__days">{left.days}天</Text>
      ) : null}
      {parts.map((part, index) => (
        <View key={index} className="shop-countdown__group">
          {index > 0 ? <Text className="shop-countdown__colon">:</Text> : null}
          <Text className="shop-countdown__digits">{part}</Text>
        </View>
      ))}
    </View>
  );
}
