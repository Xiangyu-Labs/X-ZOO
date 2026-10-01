import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  notificationAdminTemplateList,
  notificationAdminTemplatePreview,
  notificationAdminTemplateTestSend,
  notificationAdminTemplateUpdate,
} from '@shop/contracts/notification/notification.admin.contract';
import {
  notificationTemplateExample,
  type NotificationTemplate,
} from '@shop/contracts/notification/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, respondWithError, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { NotificationTemplatesPage } from './notification-templates';

/**
 * 预览 / 测试发送 in the template form. What matters is that both read the form
 * as it stands — an unsaved edit included — and that a test send is asked for
 * before it goes out.
 */

const template = notificationTemplateExample as NotificationTemplate;

function stubApi(): StubCall[] {
  return stubRoutes([
    on(notificationAdminTemplateList, { items: [template], total: 1, page: 1, pageSize: 20 }),
    on(notificationAdminTemplateUpdate, template),
    on(notificationAdminTemplatePreview, {
      inApp: {
        enabled: true,
        title: '您的订单已发货',
        content: '订单 SO202609240001 已发出',
        opens: 'packages/order/detail/index?id=1001',
      },
      wechatOa: null,
      wechatMini: null,
      sms: null,
      warnings: ['{{trackngNo}} 不是这个通知的变量（用在：站内信正文），发出去会是空的'],
    }),
    on(notificationAdminTemplateTestSend, {
      outcome: 'skipped',
      message: '没有发出：该会员没有关注公众号或没有公众号授权记录',
    }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const user = userEvent.setup({ pointerEventsCheck: 0 });

const writer = {
  ...testIdentity,
  permissions: ['notification:template:read', 'notification:template:write'],
};

async function openPreview(): Promise<HTMLElement> {
  await user.click(await screen.findByText('配置'));
  const form = await screen.findByRole('dialog');
  const title = within(form).getByLabelText('站内信标题');
  await user.clear(title);
  await user.type(title, '未保存的标题');
  await user.click(within(form).getByTestId('notification-preview'));
  return (await screen.findAllByRole('dialog')).at(-1)!;
}

describe('通知模板', () => {
  it('previews the unsaved form with sample values', { timeout: 20_000 }, async () => {
    const calls = stubApi();
    renderAdmin(<NotificationTemplatesPage />, { identity: writer });

    const dialog = await openPreview();
    expect(await within(dialog).findByTestId('notification-preview-result')).toBeInTheDocument();
    expect(within(dialog).getByText(/不是这个通知的变量/)).toBeInTheDocument();

    const call = calls.find((c) => c.url.endsWith('/notification-templates/order_shipped/preview'));
    const body = call?.body as {
      channels: { inApp: { title: string } };
      data: Record<string, string>;
    };
    expect(body.channels.inApp.title).toBe('未保存的标题');
    expect(body.data['orderNo']).toBe('SO202609240001');
  });

  it('asks before a test send and shows why nothing went out', { timeout: 20_000 }, async () => {
    const calls = stubApi();
    renderAdmin(<NotificationTemplatesPage />, { identity: writer });

    const dialog = await openPreview();
    await user.type(within(dialog).getByLabelText('会员 ID'), '10001');
    await user.click(within(dialog).getByTestId('notification-test-send'));
    expect(calls.some((c) => c.url.endsWith('/test-send'))).toBe(false);

    const confirm = (await screen.findByText('确定真实发送？')).closest('.ant-popover');
    await user.click(within(confirm as HTMLElement).getByRole('button', { name: zhName('发送') }));
    expect(await within(dialog).findByText(/该会员没有关注公众号/)).toBeInTheDocument();
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith('/order_shipped/test-send'));
      expect(call?.body).toMatchObject({ channel: 'wechatOa', userId: '10001' });
    });
  });

  it(
    'edits the SMS variables in order, says the reference text is not sent, and previews what goes out',
    { timeout: 30_000 },
    async () => {
      const withSms = {
        ...template,
        channels: {
          ...template.channels,
          sms: {
            enabled: true,
            templateCode: '520269',
            params: [{ name: '', value: '{{orderNo}}' }],
            body: '您的订单{1}已发货',
          },
        },
      } as NotificationTemplate;
      const calls = stubRoutes([
        on(notificationAdminTemplateList, { items: [withSms], total: 1, page: 1, pageSize: 20 }),
        on(notificationAdminTemplateUpdate, withSms),
        on(notificationAdminTemplatePreview, {
          inApp: null,
          wechatOa: null,
          wechatMini: null,
          sms: {
            enabled: true,
            provider: 'tencent',
            templateCode: '520269',
            signName: null,
            params: [
              { key: '{1}', value: 'SO202609240001' },
              { key: '{2}', value: '顺丰速运' },
            ],
          },
          warnings: [
            '短信变量 {1}「SO202609240001」有 14 个字，腾讯云限制验证码以外的变量最多 6 个字，会被拒收',
          ],
        }),
      ]);
      renderAdmin(<NotificationTemplatesPage />, { identity: writer });

      await user.click(await screen.findByText('配置'));
      const form = await screen.findByRole('dialog');
      expect(within(form).getByText('参考文字（不会发送）')).toBeInTheDocument();
      expect(within(form).getByText(/个数必须和服务商审核通过的模板完全一致/)).toBeInTheDocument();
      expect(within(form).getByLabelText('第 1 个变量的内容')).toHaveValue('{{orderNo}}');

      await user.click(within(form).getByRole('button', { name: /添加变量/ }));
      await user.type(within(form).getByLabelText('第 2 个变量的内容'), '{{{{company}}');

      await user.click(within(form).getByTestId('notification-preview'));
      const dialog = (await screen.findAllByRole('dialog')).at(-1)!;
      expect(await within(dialog).findByText(/腾讯云（按 \{1\}\{2\}… 顺序）/)).toBeInTheDocument();
      expect(within(dialog).getByText(/有 14 个字/)).toBeInTheDocument();
      const preview = calls.find((c) => c.url.endsWith('/order_shipped/preview'));
      expect(
        (preview?.body as { channels: { sms: { params: unknown } } }).channels.sms.params,
      ).toEqual([
        { name: '', value: '{{orderNo}}' },
        { name: '', value: '{{company}}' },
      ]);

      await user.click(
        within(dialog)
          .getAllByRole('button', { name: zhName('关闭') })
          .at(-1)!,
      );
      await user.click(within(form).getByRole('button', { name: zhName('保存') }));
      await waitFor(() => {
        const save = calls.find((c) => c.method === 'PUT');
        expect(save?.body).toMatchObject({
          channels: {
            sms: {
              templateCode: '520269',
              params: [
                { name: '', value: '{{orderNo}}' },
                { name: '', value: '{{company}}' },
              ],
            },
          },
        });
      });
    },
  );

  it(
    'opens the form read-only for a read-only admin, with no 保存 and no test send',
    { timeout: 20_000 },
    async () => {
      const calls = stubApi();
      renderAdmin(<NotificationTemplatesPage />, {
        identity: { ...testIdentity, permissions: ['notification:template:read'] },
      });

      await user.click(await screen.findByText('查看'));
      const form = await screen.findByRole('dialog');
      expect(within(form).getByLabelText('站内信标题')).toBeDisabled();
      expect(within(form).queryByRole('button', { name: zhName('保存') })).not.toBeInTheDocument();
      expect(screen.queryByText('配置')).not.toBeInTheDocument();
      await user.click(within(form).getByTestId('notification-preview'));
      const dialog = (await screen.findAllByRole('dialog')).at(-1)!;
      await within(dialog).findByTestId('notification-preview-result');
      expect(within(dialog).queryByTestId('notification-test-send')).not.toBeInTheDocument();
      expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    },
  );
});

/**
 * A row written around the save: 小程序 switched on with only a 模板库编号,
 * 公众号 switched off with its settings kept for later.
 */
const broken: NotificationTemplate = {
  ...template,
  channels: {
    inApp: { enabled: true, title: '您的订单已发货', body: '订单 {{orderNo}} 已发货' },
    wechatOa: {
      enabled: false,
      templateKey: 'OPENTM207791277',
      templateId: 'TPL-OA',
      fields: { keyword1: '{{orderNo}}' },
    },
    wechatMini: { enabled: true, templateKey: '1458' },
    sms: { enabled: false, templateCode: '', params: [] },
  },
  channelProblems: [
    {
      channel: 'wechatMini',
      kind: 'incomplete',
      missing: ['templateId', 'fields'],
      message: '已开启但无法发送：缺模板 ID、字段映射',
    },
  ],
};

const REFUSAL = '「小程序」已开启但无法发送：缺模板 ID、字段映射。请填写，或关闭该渠道后再保存';

describe('通知模板 — 已开启但无法发送', () => {
  function stubBroken(): StubCall[] {
    return stubRoutes([
      on(notificationAdminTemplateList, { items: [broken], total: 1, page: 1, pageSize: 20 }),
      on(notificationAdminTemplateUpdate, (call) => {
        const body = call.body as { channels: { wechatMini?: { enabled: boolean } } };
        if (!body.channels.wechatMini?.enabled) return broken;
        return respondWithError(422, {
          code: 'NOTIFICATION_CHANNEL_INCOMPLETE',
          message: REFUSAL,
          details: { problems: broken.channelProblems },
        });
      }),
    ]);
  }

  it('lists the channel as unable to send, not as on', { timeout: 20_000 }, async () => {
    stubBroken();
    renderAdmin(<NotificationTemplatesPage />, { identity: writer });

    const tag = await screen.findByText('小程序：已开启但无法发送：缺模板 ID、字段映射');
    const row = tag.closest('tr') as HTMLElement;
    expect(within(row).getByText('站内信')).toBeInTheDocument();
    expect(within(row).queryByText('小程序')).not.toBeInTheDocument();
  });

  it(
    'says in the form which channel is in the way and why the save was refused',
    { timeout: 20_000 },
    async () => {
      stubBroken();
      renderAdmin(<NotificationTemplatesPage />, { identity: writer });

      await user.click(await screen.findByText('配置'));
      const form = await screen.findByRole('dialog');
      expect(
        within(form).getByText(
          '小程序：已开启但无法发送：缺模板 ID、字段映射，请填写，或关闭该渠道',
        ),
      ).toBeInTheDocument();

      await user.click(within(form).getByRole('button', { name: zhName('保存') }));
      expect(await within(form).findByText(REFUSAL)).toBeInTheDocument();
      expect(within(form).queryByText(/wechatMini|templateId/)).not.toBeInTheDocument();
    },
  );

  it(
    'keeps a switched-off channel’s stored settings when it saves',
    { timeout: 20_000 },
    async () => {
      const calls = stubBroken();
      renderAdmin(<NotificationTemplatesPage />, { identity: writer });

      await user.click(await screen.findByText('配置'));
      const form = await screen.findByRole('dialog');
      await user.click(within(form).getByRole('switch', { name: '小程序 渠道' }));
      await user.click(within(form).getByRole('button', { name: zhName('保存') }));

      await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
      const body = calls.find((call) => call.method === 'PUT')?.body as NotificationTemplate;
      expect(body.channels.wechatMini).toEqual({ enabled: false, templateKey: '1458' });
      expect(body.channels.wechatOa).toEqual({
        enabled: false,
        templateKey: 'OPENTM207791277',
        templateId: 'TPL-OA',
        fields: { keyword1: '{{orderNo}}' },
      });
    },
  );
});
