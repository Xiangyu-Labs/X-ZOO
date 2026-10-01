import { describe, expect, it } from 'vitest';
import {
  normaliseOrigin,
  parseBody,
  parseLimit,
  parsePairs,
  resolveConfig,
  UsageError,
} from './args';

describe('parsePairs', () => {
  it('turns k=v into an object and a repeated key into an array', () => {
    expect(parsePairs(['id=3', 'tag=a', 'tag=b', 'note=a=b'], '--query')).toEqual({
      id: '3',
      tag: ['a', 'b'],
      note: 'a=b',
    });
  });

  it('refuses a pair without a key', () => {
    expect(() => parsePairs(['=3'], '--param')).toThrow(UsageError);
    expect(() => parsePairs(['id'], '--param')).toThrow(UsageError);
  });

  it('is empty when the flag was not given', () => {
    expect(parsePairs(undefined, '--param')).toEqual({});
  });
});

describe('parseBody', () => {
  const read = (source: string) => Promise.resolve(source === 'b.json' ? '{"from":"file"}' : '');

  it('reads inline JSON, a file after @, or nothing', async () => {
    await expect(parseBody('{"name":"茶"}', read)).resolves.toEqual({ name: '茶' });
    await expect(parseBody('@b.json', read)).resolves.toEqual({ from: 'file' });
    await expect(parseBody(undefined, read)).resolves.toBeUndefined();
  });

  it('says so when it is not JSON', async () => {
    await expect(parseBody('{name:', read)).rejects.toThrow(/不是合法的 JSON/);
  });
});

describe('normaliseOrigin', () => {
  it('keeps only the origin', () => {
    expect(normaliseOrigin('https://x-zoo.vip/admin/')).toBe('https://x-zoo.vip');
  });

  it('refuses what is not https, but lets http reach this machine', () => {
    expect(() => normaliseOrigin('ftp://x-zoo.vip')).toThrow(UsageError);
    expect(() => normaliseOrigin('x-zoo.vip')).toThrow(UsageError);
    expect(() => normaliseOrigin('http://x-zoo.vip')).toThrow(UsageError);
    expect(normaliseOrigin('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normaliseOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });
});

describe('parseLimit', () => {
  it('takes a whole number from 1 and refuses anything else', () => {
    expect(parseLimit(undefined)).toBeUndefined();
    expect(parseLimit('5')).toBe(5);
    for (const bad of ['abc', '0', '-1', '2.5']) expect(() => parseLimit(bad)).toThrow(UsageError);
  });
});

describe('resolveConfig', () => {
  const saved = { origin: 'https://x-zoo.vip', token: 'shp_saved' };

  it('uses the saved login, with its origin tidied', () => {
    expect(resolveConfig({ ...saved, origin: 'https://x-zoo.vip/' }, {})).toEqual(saved);
    expect(resolveConfig(null, {})).toBeNull();
  });

  it('takes the environment as a pair', () => {
    expect(
      resolveConfig(saved, { SHOP_ORIGIN: 'https://other.test/admin', SHOP_TOKEN: 'shp_env' }),
    ).toEqual({ origin: 'https://other.test', token: 'shp_env' });
    expect(resolveConfig(saved, { SHOP_TOKEN: 'shp_env' })).toEqual({
      origin: 'https://x-zoo.vip',
      token: 'shp_env',
    });
    expect(resolveConfig(saved, { SHOP_ORIGIN: 'https://x-zoo.vip/' })).toEqual(saved);
  });

  it('never sends the saved token to another SHOP_ORIGIN', () => {
    expect(() => resolveConfig(saved, { SHOP_ORIGIN: 'https://other.test' })).toThrow(/SHOP_TOKEN/);
    expect(() => resolveConfig(null, { SHOP_TOKEN: 'shp_env' })).toThrow(UsageError);
  });
});
