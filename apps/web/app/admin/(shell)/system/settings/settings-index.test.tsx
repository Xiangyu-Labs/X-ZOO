import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigGroupSummary } from '@shop/contracts/system/schemas';
import { systemConfigGroupList } from '@shop/contracts/system/system.settings.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin } from '@/test/render';

import { SettingsIndexPage } from './settings-index';

/**
 * 系统设置 index: each card says what is saved, and the search finds a field
 * by its label and links straight to it.
 */

const groups: ConfigGroupSummary[] = [
  {
    group: 'sms',
    title: '短信设置',
    description: '短信服务商密钥、签名、模板与发送频率。',
    category: 'integration',
    permission: 'system:config:read',
    fieldCount: 3,
    writable: true,
    testable: true,
    lastTest: null,
    status: { tone: 'incomplete', text: '腾讯云 · 缺验证码模板' },
    fieldIndex: [
      { key: 'provider', label: '短信服务商' },
      { key: 'templateVerifyCode', label: '验证码模板 ID', section: '模板' },
      { key: 'perPhonePerHour', label: '每小时上限', section: '频率' },
    ],
  },
  {
    group: 'map',
    title: '地图设置',
    category: 'integration',
    permission: 'system:config:read',
    fieldCount: 1,
    writable: true,
    status: { tone: 'off', text: '未启用' },
    fieldIndex: [{ key: 'provider', label: '地图服务商' }],
  },
];

afterEach(() => resetApiConfig());

describe('系统设置', () => {
  it("shows each group's status and whether it was tested", async () => {
    stubRoutes([on(systemConfigGroupList, { groups })]);
    renderAdmin(<SettingsIndexPage />);

    expect(await screen.findByTestId('group-status-sms')).toHaveTextContent(
      '腾讯云 · 缺验证码模板',
    );
    expect(screen.getByTestId('group-status-map')).toHaveTextContent('未启用');
    expect(screen.getByText('· 未测试')).toBeInTheDocument();
  });

  it('finds a field by its label and links to it', async () => {
    stubRoutes([on(systemConfigGroupList, { groups })]);
    renderAdmin(<SettingsIndexPage />);

    fireEvent.change(await screen.findByTestId('settings-search'), {
      target: { value: '验证码' },
    });

    const link = screen.getByRole('link', { name: /验证码模板 ID/ });
    expect(link).toHaveAttribute('href', '/admin/system/settings/sms?field=templateVerifyCode');
    expect(link).toHaveTextContent('短信设置› 模板› 验证码模板 ID');
    // Only the one match: 地图 has nothing about 验证码.
    expect(screen.queryByText('地图设置')).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    stubRoutes([on(systemConfigGroupList, { groups })]);
    renderAdmin(<SettingsIndexPage />);

    fireEvent.change(await screen.findByTestId('settings-search'), {
      target: { value: '不存在的东西' },
    });
    expect(screen.getByText('没有找到「不存在的东西」相关的设置项')).toBeInTheDocument();
  });
});
