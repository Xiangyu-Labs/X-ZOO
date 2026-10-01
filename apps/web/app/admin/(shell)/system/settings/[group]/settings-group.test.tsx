import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { paymentMiniTradeStatus } from '@shop/contracts/payment/payment.mini-trade.contract';
import type { ConfigGroupValues } from '@shop/contracts/system/schemas';
import { systemConfigGet } from '@shop/contracts/system/system.settings.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { SettingsGroupPage, groupWritePermission } from './settings-group';

/**
 * One settings group, as the role that opens it. Reading is
 * `system:config:read`; 保存 and 测试 are `system:config:write`, and the
 * 小程序发货信息管理 card is `payment:config:write` — a role short of an atom
 * sees no button that would only answer 403.
 */

const sms: ConfigGroupValues = {
  descriptor: {
    group: 'sms',
    title: '短信设置',
    permission: 'system:config:read',
    fields: [{ key: 'signName', label: '短信签名', kind: 'text' }],
    test: {
      label: '发送测试短信',
      inputs: [{ key: 'phone', label: '手机号', kind: 'text' }],
    },
  },
  values: { signName: '某某商城' },
  updatedAt: null,
};

const miniTrade: ConfigGroupValues = {
  descriptor: {
    group: 'wechat-mini-trade',
    title: '小程序发货信息管理',
    permission: 'system:config:read',
    fields: [{ key: 'uploadEnabled', label: '录入发货信息', kind: 'switch' }],
  },
  values: { uploadEnabled: true },
  updatedAt: null,
};

const reader = { ...testIdentity, permissions: ['system:config:read'] };
const writer = { ...testIdentity, permissions: ['system:config:read', 'system:config:write'] };

afterEach(() => resetApiConfig());

describe('配置分组', () => {
  it('offers 保存 and 测试 to a role that may write settings', async () => {
    stubRoutes([on(systemConfigGet, sms)]);
    renderAdmin(<SettingsGroupPage group="sms" />, { identity: writer });

    expect(await screen.findByLabelText('短信签名')).toBeEnabled();
    expect(screen.getByRole('button', { name: zhName('保存') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /发送测试短信/ })).toBeInTheDocument();
    expect(screen.queryByText('你的身份只能查看这些配置，不能在这里修改')).not.toBeInTheDocument();
  });

  it('shows a read-only role the settings without 保存 or 测试', async () => {
    stubRoutes([on(systemConfigGet, sms)]);
    renderAdmin(<SettingsGroupPage group="sms" />, { identity: reader });

    expect(await screen.findByLabelText('短信签名')).toBeDisabled();
    expect(screen.queryByRole('button', { name: zhName('保存') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /发送测试短信/ })).not.toBeInTheDocument();
    expect(screen.getByText('你的身份只能查看这些配置，不能在这里修改')).toBeInTheDocument();
  });

  it('keeps a group that narrows its atom read-only for a role without that group’s write atom', async () => {
    const payment: ConfigGroupValues = {
      ...sms,
      descriptor: { ...sms.descriptor, group: 'payment', permission: 'payment:config:read' },
    };
    stubRoutes([on(systemConfigGet, payment)]);
    renderAdmin(<SettingsGroupPage group="payment" />, {
      identity: { ...writer, permissions: [...writer.permissions, 'payment:config:read'] },
    });

    // system:config:write alone does not save 支付设置: the server wants payment:config:write.
    expect(await screen.findByLabelText('短信签名')).toBeDisabled();
    expect(screen.queryByRole('button', { name: zhName('保存') })).not.toBeInTheDocument();
    expect(groupWritePermission('payment:config:read')).toBe('payment:config:write');
  });

  it('leaves out the WeChat card, and its query, without payment:config:write', async () => {
    const calls = stubRoutes([on(systemConfigGet, miniTrade)]);
    renderAdmin(<SettingsGroupPage group="wechat-mini-trade" />, { identity: writer });

    expect(await screen.findByLabelText('录入发货信息')).toBeInTheDocument();
    expect(screen.queryByText('微信侧状态')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: zhName('同步') })).not.toBeInTheDocument();
    expect(calls.some((call) => call.routeId === paymentMiniTradeStatus.id)).toBe(false);
  });

  it('shows the WeChat card and 同步 to a role that may configure payments', async () => {
    stubRoutes([
      on(systemConfigGet, miniTrade),
      on(paymentMiniTradeStatus, {
        uploadEnabled: true,
        managed: null,
        managedCheckedAt: null,
        msgJumpPath: null,
        msgJumpPathSetAt: null,
        expectedMsgJumpPath: 'packages/order/detail/index?outTradeNo=${商品订单号}',
      }),
    ]);
    renderAdmin(<SettingsGroupPage group="wechat-mini-trade" />, {
      identity: { ...writer, permissions: [...writer.permissions, 'payment:config:write'] },
    });

    expect(await screen.findByText('微信侧状态')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: zhName('同步') })).toBeInTheDocument();
    expect(await screen.findByText('未查询')).toBeInTheDocument();
  });
});
