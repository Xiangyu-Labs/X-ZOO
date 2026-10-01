import { describe, expect, it } from 'vitest';
import { ApiError } from '@shop/api-client';
import { claimFailureText } from './use-claim';

describe('claimFailureText', () => {
  it('words a refused claim the same wherever 领取 is', () => {
    const refused = (code: string, message: string) => new ApiError({ status: 409, code, message });
    expect(claimFailureText(refused('COUPON_SOLD_OUT', '该优惠券已被领完'))).toBe(
      '来晚了，券已抢光',
    );
    expect(claimFailureText(refused('COUPON_PER_USER_LIMIT_REACHED', '您已领取过该优惠券'))).toBe(
      '已达领取上限',
    );
    expect(claimFailureText(new Error('网络不太好'))).toBe('网络不太好');
    expect(claimFailureText(null)).toBe('领取失败，请稍后重试');
  });
});
