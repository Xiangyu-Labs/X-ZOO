import { describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../kernel/context';
import { expectOk } from './wechat-oa.client';

const warn = vi.fn();
const ctx = { logger: { warn } } as unknown as Pick<Ctx, 'logger'>;

describe('expectOk', () => {
  it('passes an envelope WeChat said yes to', () => {
    expect(expectOk(ctx, { errcode: 0, errmsg: 'ok' }, '发布菜单')).toEqual({
      errcode: 0,
      errmsg: 'ok',
    });
    expect(expectOk(ctx, {}, '发布菜单')).toEqual({});
  });

  // The message is the admin toast and `publish_error`: Chinese and the
  // errcode, never WeChat's English errmsg, which goes to the log (AGENTS rule 1).
  it('refuses with what failed, why and the errcode, and keeps the errmsg out of it', () => {
    const refusal = (() => {
      try {
        expectOk(
          ctx,
          { errcode: 40164, errmsg: 'invalid ip 1.2.3.4, not in whitelist' },
          '发布菜单',
        );
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(refusal).toMatchObject({
      code: 'WECHAT_OA_API_FAILED',
      message:
        '发布菜单失败：本服务器的出口 IP 不在「IP 白名单」里，请到公众平台「开发 → 基本配置」添加（错误码 40164）',
      details: { errcode: 40164 },
    });
    expect(JSON.stringify(refusal)).not.toContain('invalid ip');
    expect(warn).toHaveBeenCalledWith(
      { what: '发布菜单', errcode: 40164, errmsg: 'invalid ip 1.2.3.4, not in whitelist' },
      'wechat oa call refused',
    );
  });

  it('says an errcode it has no hint for as the errcode alone', () => {
    expect(() => expectOk(ctx, { errcode: 65301, errmsg: 'no such menu' }, '删除菜单')).toThrow(
      '删除菜单失败（错误码 65301）',
    );
  });
});
