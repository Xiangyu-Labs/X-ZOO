import { describe, expect, it } from 'vitest';
import { checkNewPassword } from './password';

describe('checkNewPassword', () => {
  it('wants 6 to 64 characters of two kinds, then the same twice', () => {
    expect(checkNewPassword({ password: 'ab123', confirm: 'ab123' })).toEqual({
      password: '密码为 6–64 位',
    });
    expect(checkNewPassword({ password: '123456', confirm: '123456' })).toEqual({
      password: '密码需包含字母、数字或符号中的至少两类',
    });
    expect(checkNewPassword({ password: 'abc123', confirm: 'abc124' })).toEqual({
      confirm: '两次输入的密码不一致',
    });
    expect(checkNewPassword({ password: 'abc123', confirm: 'abc123' })).toEqual({});
  });
});
