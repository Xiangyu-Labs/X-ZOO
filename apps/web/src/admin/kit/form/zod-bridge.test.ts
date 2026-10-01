import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { matchFieldErrors, maxLengthOf } from './zod-bridge';

describe('maxLengthOf', () => {
  it('reads the limit through optional, nullable, default and transform', () => {
    expect(maxLengthOf(z.string().max(64))).toBe(64);
    expect(maxLengthOf(z.string().trim().min(1).max(20).optional())).toBe(20);
    expect(maxLengthOf(z.string().max(30).nullable().default(null))).toBe(30);
    expect(
      maxLengthOf(
        z
          .string()
          .max(12)
          .transform((value) => value.toUpperCase()),
      ),
    ).toBe(12);
  });

  it('has nothing to say about an unlimited text or a non-text field', () => {
    expect(maxLengthOf(z.string())).toBeUndefined();
    expect(maxLengthOf(z.number().max(5))).toBeUndefined();
    expect(maxLengthOf(undefined)).toBeUndefined();
  });
});

describe('matchFieldErrors', () => {
  it('matches a path to the field that renders it, by the name the field registered', () => {
    expect(matchFieldErrors({ name: '必填' }, ['name', 'note'])).toEqual({
      matched: [{ name: ['name'], errors: ['必填'] }],
      unmatched: [],
    });
  });

  it('matches a numeric segment whichever way the field spelled it', () => {
    expect(matchFieldErrors({ 'a.0.b': '有误' }, [['a', 0, 'b']]).matched).toEqual([
      { name: ['a', 0, 'b'], errors: ['有误'] },
    ]);
    expect(matchFieldErrors({ 'a.0.b': '有误' }, ['a.0.b']).matched).toEqual([
      { name: ['a', '0', 'b'], errors: ['有误'] },
    ]);
  });

  it('puts an error inside a field on the nearest field that holds it', () => {
    expect(
      matchFieldErrors(
        {
          'skus.1.price': '价格不合法',
          'skus.2.price': '价格不合法',
          'skus.2.stock': '库存不能为负',
        },
        ['name', 'skus'],
      ),
    ).toEqual({
      matched: [{ name: ['skus'], errors: ['价格不合法', '库存不能为负'] }],
      unmatched: [],
    });
  });

  it('reports what no field renders instead of dropping it', () => {
    expect(
      matchFieldErrors(
        { name: '必填', 'params.id': 'ID 不合法', 'query.page': '页码不合法', ghost: '不存在' },
        ['name'],
      ),
    ).toEqual({
      matched: [{ name: ['name'], errors: ['必填'] }],
      unmatched: ['ID 不合法', '页码不合法', '不存在'],
    });
  });

  it('reports each unmatched message once', () => {
    expect(matchFieldErrors({ a: '有误', b: '有误' }, []).unmatched).toEqual(['有误']);
  });

  it('strips a body prefix before matching, and only that prefix', () => {
    expect(
      matchFieldErrors({ 'values.siteName': '必填', 'params.group': '分组不存在' }, ['siteName'], {
        prefix: 'values',
      }),
    ).toEqual({
      matched: [{ name: ['siteName'], errors: ['必填'] }],
      unmatched: ['分组不存在'],
    });
  });

  it('does not match an empty path to anything', () => {
    expect(matchFieldErrors({ '': '整体有误' }, ['name'])).toEqual({
      matched: [],
      unmatched: ['整体有误'],
    });
  });
});
