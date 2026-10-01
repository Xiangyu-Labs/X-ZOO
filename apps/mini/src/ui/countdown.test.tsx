import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setServerTime } from '@/lib/server-clock';
import { taroFake } from '@/test/taro-fake/taro';
import { Countdown, remainingUntil } from './countdown';

const NOW = Date.parse('2026-09-23T10:00:00+08:00');

describe('Countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setServerTime(NOW, NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    setServerTime(Date.now(), Date.now());
  });

  it('splits what is left into days, hours, minutes and seconds', () => {
    expect(remainingUntil(NOW + 90_061_000, NOW)).toMatchObject({
      days: 1,
      hours: 1,
      minutes: 1,
      seconds: 1,
    });
    expect(remainingUntil(NOW - 5000, NOW).total).toBe(0);
  });

  it('ticks each second and calls onEnd once at zero', () => {
    const onEnd = vi.fn();
    render(<Countdown endsAt="2026-09-23T10:00:03+08:00" onEnd={onEnd} />);
    expect(screen.getByRole('timer', { name: '剩余0小时0分3秒' }).textContent).toBe('00:00:03');
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('timer').textContent).toBe('00:00:02');
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText('已结束')).toBeTruthy();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('stops ticking at zero, and starts again when the deadline moves', () => {
    const onEnd = vi.fn();
    const view = render(<Countdown endsAt="2026-09-23T10:00:02+08:00" onEnd={onEnd} />);
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText('已结束')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);

    view.rerender(<Countdown endsAt="2026-09-23T10:00:05+08:00" onEnd={onEnd} />);
    expect(screen.getByRole('timer').textContent).toBe('00:00:02');
    act(() => vi.advanceTimersByTime(3000));
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shown after the deadline: 已结束 at once, no ticking, no onEnd', () => {
    const onEnd = vi.fn();
    render(<Countdown endsAt="2026-09-23T09:59:00+08:00" onEnd={onEnd} />);
    expect(screen.getByText('已结束')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('counts on the server clock, not the phone', () => {
    // The phone is 10 minutes fast.
    setServerTime(NOW - 600_000, NOW);
    render(<Countdown endsAt="2026-09-23T09:55:00+08:00" />);
    expect(screen.getByRole('timer').textContent).toBe('00:05:00');
  });

  it('shows days in dhms format', () => {
    render(<Countdown endsAt="2026-09-25T11:00:00+08:00" format="dhms" variant="boxed" />);
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('2天01:00:00');
    expect(timer.className).toContain('shop-countdown--boxed');
  });

  it('shares one timer between countdowns, so a list of them renders once a second', () => {
    render(
      <>
        <Countdown endsAt="2026-09-23T10:00:30+08:00" />
        <Countdown endsAt="2026-09-23T10:01:00+08:00" />
        <Countdown endsAt="2026-09-23T10:02:00+08:00" />
      </>,
    );
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getAllByRole('timer').map((timer) => timer.textContent)).toEqual([
      '00:00:29',
      '00:00:59',
      '00:01:59',
    ]);
  });

  it('stops ticking while its page is hidden and catches up when it shows again', () => {
    const { unmount } = render(<Countdown endsAt="2026-09-23T10:01:00+08:00" />);
    act(() => taroFake.hidePage());
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('timer').textContent).toBe('00:01:00');
    act(() => taroFake.showPage());
    expect(screen.getByRole('timer').textContent).toBe('00:00:50');
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
