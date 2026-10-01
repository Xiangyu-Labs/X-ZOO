import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import './locale';

function messageOf(schema: z.ZodType, value: unknown): string | undefined {
  const result = schema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe('zod messages a person reads', () => {
  it('asks for an empty required field instead of naming types', () => {
    expect(messageOf(z.string(), undefined)).toBe('请填写此项');
    expect(messageOf(z.string().min(1), '')).toBe('请填写此项');
    expect(messageOf(z.number(), null)).toBe('请填写此项');
    expect(messageOf(z.enum(['a', 'b']), undefined)).toBe('请选择此项');
  });

  it('says how long, how many and how much in plain words', () => {
    expect(messageOf(z.string().max(5), 'abcdefg')).toBe('最多 5 个字');
    expect(messageOf(z.string().min(6), 'abc')).toBe('至少 6 个字');
    expect(messageOf(z.number().min(1), 0)).toBe('不能小于 1');
    expect(messageOf(z.number().positive(), 0)).toBe('必须大于 0');
    expect(messageOf(z.coerce.number().int().max(100), '200')).toBe('不能大于 100');
    expect(messageOf(z.array(z.string()).min(1), [])).toBe('请至少选择一项');
    expect(messageOf(z.number().int(), 1.5)).toBe('请输入整数');
    expect(messageOf(z.enum(['a', 'b']), 'c')).toBe('请选择有效的选项');
    expect(messageOf(z.string().regex(/^\d+$/), 'x')).toBe('格式不正确');
  });

  it('never overrides the message a schema gives itself', () => {
    expect(messageOf(z.string().min(2, '名称太短'), 'a')).toBe('名称太短');
  });
});
