import { describe, expect, it } from 'vitest';
import { parseQuery } from './query';

describe('parseQuery', () => {
  it('reads names and values, decoded', () => {
    expect(parseQuery('id=12&q=%E7%99%BD+L&flag')).toEqual({ id: '12', q: '白 L', flag: '' });
  });

  it('takes a leading ?, skips empty pairs and keeps the first of a repeated name', () => {
    expect(parseQuery('?a=1&&a=2&b=')).toEqual({ a: '1', b: '' });
  });

  it('keeps a value that is not valid URI encoding as written', () => {
    expect(parseQuery('x=100%')).toEqual({ x: '100%' });
  });

  it('is empty for an empty string', () => {
    expect(parseQuery('')).toEqual({});
  });
});
