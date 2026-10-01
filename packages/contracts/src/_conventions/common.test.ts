import { describe, expect, it } from 'vitest';
import { adminPasswordBody } from '../system/schemas';
import { newPassword } from './common';

describe('newPassword', () => {
  it('counts bytes, because bcrypt does', () => {
    const schema = newPassword(8);
    expect(schema.safeParse('密'.repeat(24)).success).toBe(true); // 72 bytes
    expect(schema.safeParse('密'.repeat(25)).success).toBe(false); // 75 bytes
    expect(schema.safeParse('a'.repeat(72)).success).toBe(true);
    expect(schema.safeParse('a'.repeat(73)).success).toBe(false);
  });

  it('turns an over-long password into a validation message rather than a 500 in core', () => {
    const parsed = adminPasswordBody.safeParse({ password: '一个很长很长的中文密码'.repeat(3) });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]!.message).toContain('72 字节');
  });
});
