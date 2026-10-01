'use client';

import { Alert, Input, Space, Tag, Typography } from 'antd';
import {
  notificationAdminTemplateList,
  notificationAdminTemplateUpdate,
} from '@shop/contracts/notification/notification.admin.contract';
import {
  notificationTemplateForm,
  TENCENT_SMS_PARAM_LIMIT,
  type NotificationChannel,
  type NotificationChannelProblem,
  type NotificationTemplate,
  type NotificationTemplateForm,
  type SmsTemplateParam,
} from '@shop/contracts/notification/schemas';

import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import type { FieldSpec } from '@/admin/kit/form/types';
import { PageContainer } from '@/admin/kit/page-container';
import { useCan } from '@/admin/session/session-provider';
import { StatusTag } from '@/admin/kit/status-tag';
import { enumColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

import { NOTIFICATION_AUDIENCE, NOTIFICATION_CHANNEL } from '../notification-enums';
import { FieldMapField } from './field-map-field';
import { NotificationPreviewButton } from './notification-preview';

/**
 * 通知模板 — which events the shop sends, and down which channels.
 *
 * The rows come from the **code**, not from the table: the registry in
 * `core/src/notification/notification.registry.ts` is what the system can
 * actually send, and the table only remembers the operator's choices. So there
 * is no 新建 button and no delete — an event nobody wrote code for could never
 * fire, and a row for it would only invite operators to keep editing it.
 *
 * Only the channels an event supports get switches. A customer event has no
 * admin inbox and an admin event has no openid, so offering the switch would be
 * offering a setting that silently does nothing.
 */
export function NotificationTemplatesPage() {
  const modal = useFormModal<NotificationTemplate>();
  // Saving is `notification:template:write`. A reader still opens the form —
  // to see the wording and 预览 it — but read-only, with no 保存 into a 403.
  const mayWrite = useCan()('notification:template:write');

  return (
    <PageContainer subTitle="事件由代码定义，这里只决定发哪些渠道、用什么措辞。改完在配置窗口里「预览」看实际效果">
      <CrudTable
        route={notificationAdminTemplateList}
        scrollX={1200}
        filters={[
          { kind: 'text', name: 'keyword', label: '名称或编码' },
          {
            kind: 'select',
            name: 'audience',
            label: '接收方',
            options: Object.entries(NOTIFICATION_AUDIENCE).map(([value, option]) => ({
              value,
              label: option.label,
            })),
          },
        ]}
        columns={[
          textColumn<NotificationTemplate>({ title: '名称', dataIndex: 'name', ellipsis: true }),
          textColumn<NotificationTemplate>({ title: '编码', dataIndex: 'code', width: 200 }),
          enumColumn<NotificationTemplate, NotificationTemplate['audience']>({
            title: '接收方',
            dataIndex: 'audience',
            map: NOTIFICATION_AUDIENCE,
          }),
          {
            title: '已启用渠道',
            key: 'channels',
            width: 260,
            // A switch that is on but cannot send is not "on": the send skips it
            // without a word, so the list is where the operator finds out.
            render: (_value: unknown, row: NotificationTemplate) => {
              const broken = new Set(row.channelProblems.map((problem) => problem.channel));
              const on = row.supportedChannels.filter(
                (channel) => row.channels[channel]?.enabled && !broken.has(channel),
              );
              if (on.length === 0 && broken.size === 0)
                return <Typography.Text type="secondary">未启用</Typography.Text>;
              return (
                <Space size={4} wrap>
                  {on.map((channel) => (
                    <StatusTag key={channel} value={channel} map={NOTIFICATION_CHANNEL} />
                  ))}
                  {row.channelProblems.map((problem) => (
                    <Tag key={problem.channel} color="error">
                      {NOTIFICATION_CHANNEL[problem.channel].label}：{problem.message}
                    </Tag>
                  ))}
                </Space>
              );
            },
          },
          {
            title: '总开关',
            key: 'isEnabled',
            width: 90,
            render: (_value: unknown, row: NotificationTemplate) =>
              row.isEnabled ? <Tag color="success">开</Tag> : <Tag>关</Tag>,
          },
          instantColumn<NotificationTemplate>({ title: '更新时间', dataIndex: 'updatedAt' }),
          {
            title: '操作',
            key: 'actions',
            width: 90,
            fixed: 'right' as const,
            render: (_value: unknown, row: NotificationTemplate) => (
              <Typography.Link onClick={() => modal.show(row)}>
                {mayWrite ? '配置' : '查看'}
              </Typography.Link>
            ),
          },
        ]}
      />

      {modal.record ? (
        <ModalForm
          {...modal.props}
          key={modal.record.code}
          title={`${mayWrite ? '配置' : '查看'}：${modal.record.name}`}
          readOnly={!mayWrite}
          size="large"
          columns={1}
          schema={notificationTemplateForm}
          fields={fieldsFor(modal.record)}
          initialValues={{ channels: modal.record.channels, isEnabled: modal.record.isEnabled }}
          route={notificationAdminTemplateUpdate}
          toInput={(values) => ({
            params: { code: modal.record!.code },
            body: keepStoredWhenOff(modal.record!, values),
          })}
          invalidate={[notificationAdminTemplateList]}
          successMessage="已保存"
          header={
            <>
              <ChannelProblems problems={modal.record.channelProblems} />
              <Placeholders variables={modal.record.variables} />
            </>
          }
          footerExtra={(form) => <NotificationPreviewButton template={modal.record!} form={form} />}
        />
      ) : null}
    </PageContainer>
  );
}

/**
 * The switches that are on and will not send, as the record stands. A channel
 * the event cannot use has no switch in this form, so the save leaves it out,
 * which turns it off.
 */
function ChannelProblems({ problems }: { problems: readonly NotificationChannelProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 16 }}
      message="以下渠道已开启但无法发送"
      description={problems.map((problem) => (
        <div key={problem.channel}>
          {NOTIFICATION_CHANNEL[problem.channel].label}：{problem.message}
          {problem.kind === 'notApplicable' ? '，保存后会关闭' : '，请填写，或关闭该渠道'}
        </div>
      ))}
    />
  );
}

/**
 * A switched-off channel's details are not on screen, so the form does not
 * send them, and the save would store the channel blank: switch 公众号 off for
 * a week and its template id and field map are gone when it comes back on. The
 * operator could not have edited what they could not see, so what is stored
 * goes back with the switch off.
 */
function keepStoredWhenOff(
  template: NotificationTemplate,
  values: NotificationTemplateForm,
): NotificationTemplateForm {
  const channels: Record<string, unknown> = { ...values.channels };
  for (const channel of template.supportedChannels) {
    const sent = values.channels[channel];
    const stored = template.channels[channel];
    if (sent && !sent.enabled && stored) channels[channel] = { ...stored, enabled: false };
  }
  return { ...values, channels: channels as NotificationTemplateForm['channels'] };
}

/** The `{{…}}` names this event provides. Without them the form is guesswork. */
function Placeholders({ variables }: { variables: readonly string[] }) {
  if (variables.length === 0) return null;
  return (
    <Typography.Paragraph type="secondary">
      可用占位符：
      {variables.map((name) => (
        <Typography.Text key={name} code>
          {`{{${name}}}`}
        </Typography.Text>
      ))}
    </Typography.Paragraph>
  );
}

type FormField = FieldSpec<'channels' | 'isEnabled'>;

/**
 * One block of fields per supported channel, plus the master switch.
 *
 * `visibleWhen` hides a channel's details until it is switched on: the form is
 * four channels wide and an operator editing the in-app copy does not
 * need to scroll past three WeChat template ids they are not using.
 */
function fieldsFor(template: NotificationTemplate): FormField[] {
  const fields: FormField[] = [
    {
      kind: 'switch',
      name: 'isEnabled',
      label: '总开关',
      help: '关闭后该事件的所有渠道都不发送，已排队的发送也会跳过',
    },
  ];

  const enabled = (channel: NotificationChannel) => (values: Record<string, unknown>) =>
    Boolean(
      (values['channels'] as Record<string, { enabled?: boolean }> | undefined)?.[channel]?.enabled,
    );

  for (const channel of template.supportedChannels) {
    fields.push({
      kind: 'switch',
      name: ['channels', channel, 'enabled'],
      label: `${NOTIFICATION_CHANNEL[channel].label} 渠道`,
    });

    if (channel === 'inApp') {
      fields.push(
        {
          kind: 'text',
          name: ['channels', 'inApp', 'title'],
          label: '站内信标题',
          visibleWhen: enabled('inApp'),
        },
        {
          kind: 'textarea',
          name: ['channels', 'inApp', 'body'],
          label: '站内信正文',
          rows: 3,
          visibleWhen: enabled('inApp'),
        },
      );
      continue;
    }

    if (channel === 'sms') {
      fields.push(
        {
          kind: 'text',
          name: ['channels', 'sms', 'templateCode'],
          label: '短信模板编号',
          help: '服务商审核通过的模板 ID：腾讯云是一串数字，阿里云是 SMS_ 开头的模板 CODE',
          visibleWhen: enabled('sms'),
        },
        {
          kind: 'text',
          name: ['channels', 'sms', 'signName'],
          label: '短信签名',
          help: '留空就用「系统设置 → 短信设置」里的签名',
          visibleWhen: enabled('sms'),
        },
        {
          kind: 'sortableList',
          name: ['channels', 'sms', 'params'],
          label: '模板变量（按顺序）',
          help: <SmsParamsHelp />,
          addText: '添加变量',
          emptyText: '不传任何变量（模板里没有 {1}、${…} 这样的变量时就保持为空）',
          max: 20,
          newItem: () => ({ name: '', value: '' }),
          renderItem: (item: never, helpers) => (
            <SmsParamRow
              param={item as unknown as SmsTemplateParam}
              index={helpers.index}
              disabled={helpers.disabled}
              onChange={(next) => helpers.set(next as unknown as never)}
            />
          ),
          visibleWhen: enabled('sms'),
        },
        {
          kind: 'textarea',
          name: ['channels', 'sms', 'body'],
          label: '参考文字（不会发送）',
          rows: 2,
          help: '只给自己看的模板原文备忘。真正发出的文字是服务商审核通过的模板，这里改了不影响短信内容',
          visibleWhen: enabled('sms'),
        },
      );
      continue;
    }

    // wechatOa / wechatMini share a shape.
    fields.push(
      {
        kind: 'text',
        name: ['channels', channel, 'templateKey'],
        label: '模板库编号',
        help: '公众平台上可查的 OPENTM / TM 编号，换店铺时用它重新找回模板',
        visibleWhen: enabled(channel),
      },
      {
        kind: 'text',
        name: ['channels', channel, 'templateId'],
        label: '模板 ID',
        help: '本账号添加模板后得到的 ID，接口真正使用的是它',
        visibleWhen: enabled(channel),
      },
      {
        kind: 'custom',
        name: ['channels', channel, 'fields'],
        label: '字段映射',
        help: '左边是微信模板的字段名（first、keyword1、thing3…），右边是我们的占位符',
        visibleWhen: enabled(channel),
        render: ({ value, onChange, disabled }) => (
          <FieldMapField
            value={value as Record<string, string> | undefined}
            onChange={onChange as (next: Record<string, string>) => void}
            disabled={disabled}
            variables={template.variables}
          />
        ),
      },
    );
    // The mini program's page is the event's own route; only the 公众号
    // message takes a hand-typed link.
    if (channel === 'wechatOa') {
      fields.push({
        kind: 'text',
        name: ['channels', 'wechatOa', 'linkUrl'],
        label: '点击跳转',
        visibleWhen: enabled('wechatOa'),
      });
    }
  }

  return fields;
}

/** What an operator must know before filling the list, or every SMS is refused. */
function SmsParamsHelp() {
  return (
    <>
      按模板里 {'{1}'}、{'{2}'}… 的顺序一行一个，个数必须和服务商审核通过的模板完全一致，
      模板没有变量就一行都不要加。每行可以用占位符，例如 {'{{orderNo}}'}。
      腾讯云：除验证码外每个变量最多 {TENCENT_SMS_PARAM_LIMIT} 个字，订单号这类长内容会被拒收，
      「变量名」不用填。阿里云：「变量名」填模板里 {'${…}'}{' '}
      括号中的名字。点「预览」可以看到实际交给服务商的变量。
    </>
  );
}

/** One SMS template variable: its slot, the Aliyun name, and what fills it. */
function SmsParamRow({
  param,
  index,
  disabled,
  onChange,
}: {
  param: SmsTemplateParam;
  index: number;
  disabled: boolean;
  onChange: (next: SmsTemplateParam) => void;
}) {
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input
        style={{ width: 64 }}
        value={`{${index + 1}}`}
        disabled
        aria-label={`第 ${index + 1} 个变量的位置`}
      />
      <Input
        style={{ width: '28%' }}
        value={param.name}
        disabled={disabled}
        placeholder="变量名（仅阿里云）"
        aria-label={`第 ${index + 1} 个变量的变量名`}
        onChange={(event) => onChange({ ...param, name: event.target.value })}
      />
      <Input
        value={param.value}
        disabled={disabled}
        placeholder="内容，可用 {{占位符}}"
        aria-label={`第 ${index + 1} 个变量的内容`}
        onChange={(event) => onChange({ ...param, value: event.target.value })}
      />
    </Space.Compact>
  );
}
