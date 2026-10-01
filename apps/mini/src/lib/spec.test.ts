import { describe, expect, it } from 'vitest';
import { formatSpec } from './spec';

describe('formatSpec', () => {
  it('shows the values of a spec apart', () => {
    expect(formatSpec('白|L')).toBe('白 / L');
    expect(formatSpec('标准装')).toBe('标准装');
  });

  it('drops empty values and says nothing for no spec', () => {
    expect(formatSpec(' 黑 || M ')).toBe('黑 / M');
    expect(formatSpec('')).toBe('');
    expect(formatSpec(null)).toBe('');
    expect(formatSpec(undefined)).toBe('');
  });
});
