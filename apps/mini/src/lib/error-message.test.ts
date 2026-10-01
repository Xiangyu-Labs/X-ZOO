import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@shop/api-client';
import { errorMessage } from './error-message';

describe('errorMessage', () => {
  it("passes the server's own Chinese words through", () => {
    const error = new ApiError({ status: 409, code: 'CART_X', message: '库存不足' });
    expect(errorMessage(error)).toBe('库存不足');
  });

  it('keeps a Chinese message of our own', () => {
    expect(errorMessage(new Error('暂时无法发起支付，请稍后再试'))).toBe(
      '暂时无法发起支付，请稍后再试',
    );
  });

  it("never shows a runtime's English, WeChat's errMsg object or [object Object]", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(errorMessage(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(
      '操作失败，请稍后再试',
    );
    expect(errorMessage({ errMsg: 'login:fail timeout' }, '登录失败，请重试')).toBe(
      '登录失败，请重试',
    );
    expect(errorMessage('boom', '登录失败，请重试')).toBe('登录失败，请重试');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
