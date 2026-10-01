import type { WechatMenuButtonShape } from '@shop/contracts/wechat-oa/schemas';
import { describe, expect, it } from 'vitest';
import { validateMenuTree } from './wechat-oa.menu.service';

/**
 * The menu rules are WeChat's, and the point of checking them here is the
 * message: `cgi-bin/menu/create` answers `40017 invalid button type` without
 * saying *which* button, so the operator retypes the whole tree to find it.
 */

const view = (name: string, url = 'https://shop.example.com/'): WechatMenuButtonShape => ({
  name,
  type: 'view',
  url,
});

describe('validateMenuTree', () => {
  it('accepts a parent with children and a leaf beside it', () => {
    expect(() =>
      validateMenuTree([
        { name: '商城', sub_button: [view('首页'), view('我的订单')] },
        { name: '联系客服', type: 'click', key: 'CONTACT' },
      ]),
    ).not.toThrow();
  });

  it('refuses an empty tree and a fourth top-level button', () => {
    expect(() => validateMenuTree([])).toThrow(/1 到 3/);
    expect(() => validateMenuTree([view('一'), view('二'), view('三'), view('四')])).toThrow(
      /1 到 3/,
    );
  });

  it('refuses a sixth child and names the parent', () => {
    expect(() =>
      validateMenuTree([{ name: '商城', sub_button: Array.from({ length: 6 }, () => view('页')) }]),
    ).toThrow(/菜单「1」最多只能有 5 个子菜单/);
  });

  it('refuses an action on a parent button', () => {
    // WeChat ignores it, which is how an operator ends up convinced the link is
    // broken rather than unreachable.
    expect(() =>
      validateMenuTree([
        { name: '商城', type: 'view', url: 'https://x/', sub_button: [view('首页')] },
      ]),
    ).toThrow(/不能再设置动作类型/);
  });

  it('refuses a third level', () => {
    expect(() =>
      validateMenuTree([
        {
          name: '商城',
          sub_button: [{ name: '首页', sub_button: [view('更深')] } as WechatMenuButtonShape],
        },
      ]),
    ).toThrow(/二级菜单不能再有子菜单/);
  });

  it('names the child that is wrong, not just the parent', () => {
    expect(() =>
      validateMenuTree([
        { name: '商城', sub_button: [view('首页'), { name: '订单', type: 'view' }] },
      ]),
    ).toThrow(/菜单「1-2」缺少跳转链接/);
  });

  it('demands the field each action type needs', () => {
    expect(() => validateMenuTree([{ name: '客服', type: 'click' }])).toThrow(/缺少 key/);
    expect(() => validateMenuTree([{ name: '小程序', type: 'miniprogram' }])).toThrow(
      /缺少小程序 appid/,
    );
    expect(() =>
      validateMenuTree([{ name: '小程序', type: 'miniprogram', appid: 'wx1', pagepath: 'p' }]),
    ).toThrow(/兜底链接/);
    expect(() => validateMenuTree([{ name: '无类型' }])).toThrow(/缺少动作类型/);
    expect(() => validateMenuTree([{ name: '  ', type: 'view', url: 'https://x/' }])).toThrow(
      /缺少名称/,
    );
  });
});
