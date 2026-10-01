import { describe, expect, it } from 'vitest';

import { deltaPercent, formatAxis, formatFigure } from './format';

describe('formatFigure', () => {
  it('writes money with a symbol, two decimals and thousands separators', () => {
    expect(formatFigure(82310.4, 'money')).toBe('¥82,310.40');
    expect(formatFigure(-145, 'money')).toBe('-¥145.00');
  });

  it('rounds counts and never shows a fraction of an order', () => {
    expect(formatFigure(1820, 'count')).toBe('1,820');
    expect(formatFigure(3.6, 'count')).toBe('4');
  });

  it('writes a percent with two decimals', () => {
    expect(formatFigure(17.5, 'percent')).toBe('17.50%');
  });

  it('writes a duration in seconds as 秒, 分 and 小时', () => {
    expect(formatFigure(0, 'duration')).toBe('0秒');
    expect(formatFigure(45.4, 'duration')).toBe('45秒');
    expect(formatFigure(65, 'duration')).toBe('1分05秒');
    expect(formatFigure(7380, 'duration')).toBe('2小时03分');
  });
});

describe('formatAxis', () => {
  it('shortens large money to 万, which is how the figure is read aloud here', () => {
    expect(formatAxis(82310.4, 'money')).toBe('8.2万');
    expect(formatAxis(950.5, 'money')).toBe('950.50');
  });

  it('leaves counts grouped', () => {
    expect(formatAxis(12345, 'count')).toBe('12,345');
  });
});

describe('deltaPercent', () => {
  it('is the change against the previous window, to two decimals', () => {
    expect(deltaPercent(110, 100)).toBe(10);
    expect(deltaPercent(96, 104)).toBe(-7.69);
  });

  it('is null when there is nothing to compare against', () => {
    // A running total sends `previous: null` …
    expect(deltaPercent(18422, null)).toBeNull();
    // … and "up ∞%" is not a fact about the shop.
    expect(deltaPercent(5, 0)).toBeNull();
  });
});
