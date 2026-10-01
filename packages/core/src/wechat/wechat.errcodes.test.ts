import { describe, expect, it } from 'vitest';
import { wechatErrcodeHint, wechatRefusal } from './wechat.errcodes';

describe('wechatRefusal', () => {
  it('says what failed, why when the code is known, and the code', () => {
    expect(wechatRefusal('获取微信接口凭证失败', 40125)).toBe(
      '获取微信接口凭证失败：AppSecret 不正确（错误码 40125）',
    );
    expect(wechatRefusal('发布菜单失败', 40164)).toContain('IP 白名单');
  });

  it('says an unknown code as the code alone, and no code as nothing', () => {
    expect(wechatRefusal('删除菜单失败', 65301)).toBe('删除菜单失败（错误码 65301）');
    expect(wechatRefusal('小程序登录失败', undefined)).toBe('小程序登录失败');
    expect(wechatRefusal('小程序登录失败', -1)).toBe('小程序登录失败');
  });
});

describe('one table per code', () => {
  it('does not explain a send refusal, which is notification.send.ts’s', () => {
    for (const code of [43004, 43101, 43102, 43116, 47003, 40003, 40037, 41030]) {
      expect(wechatErrcodeHint(code)).toBeUndefined();
    }
  });
});
