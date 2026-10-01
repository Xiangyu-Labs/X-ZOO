'use client';

import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Tag,
  Typography,
  type FormInstance,
} from 'antd';
import { useState, type ReactNode } from 'react';
import {
  notificationAdminTemplatePreview,
  notificationAdminTemplateTestSend,
} from '@shop/contracts/notification/notification.admin.contract';
import {
  notificationChannels,
  type NotificationChannels,
  type NotificationTemplate,
  type NotificationTemplatePreview,
  type NotificationTestChannel,
} from '@shop/contracts/notification/schemas';

import { errorMessage } from '@/admin/api/errors';
import { useRouteMutation } from '@/admin/api/hooks';
import { useCan } from '@/admin/session/session-provider';

import { NOTIFICATION_CHANNEL } from '../notification-enums';

/**
 * Plausible values for every placeholder the registry declares, so the
 * preview reads like a real message the moment it opens. A name missing here
 * falls back to `测试`; the operator can overwrite any of them.
 */
const SAMPLES: Record<string, string> = {
  orderId: '1001',
  orderNo: 'SO202609240001',
  amount: '199.00',
  oldAmount: '219.00',
  paidAt: '2026-09-24 10:30',
  expiresAt: '2026-09-24 11:00',
  company: '顺丰速运',
  trackingNo: 'SF1234567890',
  courierName: '张师傅',
  courierPhone: '13800000000',
  deliveryInfo: '顺丰速运 SF1234567890',
  reason: '商品有破损',
  refundId: '2001',
  refundNo: 'RF202609240001',
  refundNote: '的 ¥199.00 将原路退回',
  productId: '3001',
  productName: '经典白 T 恤',
  stock: '3',
  threshold: '10',
  groupId: '5001',
  activityTitle: '中秋三人团',
  seatsTotal: '3',
  seatsLeft: '1',
  shipDate: '2026-10-01',
  exceptionId: '4001',
  outTradeNo: 'PAY202609240001',
  transactionId: '4200001234202609240001',
  mchId: '1900000001',
  expectedMchId: '1900000002',
};

const SMS_PROVIDER: Record<NonNullable<NotificationTemplatePreview['sms']>['provider'], string> = {
  none: '未选择短信服务商',
  aliyun: '阿里云（按变量名）',
  tencent: '腾讯云（按 {1}{2}… 顺序）',
};

const TEST_CHANNELS: NotificationTestChannel[] = ['wechatOa', 'wechatMini', 'sms'];

function samplesFor(variables: readonly string[]): Record<string, string> {
  return Object.fromEntries(variables.map((name) => [name, SAMPLES[name] ?? '测试']));
}

/**
 * 预览 in the template form: the channels as they stand in the form — saved
 * or not — filled with sample values by the send path's own render functions,
 * plus what the send would silently do (an unknown placeholder, a field WeChat
 * would reject). A user event can also send one real message to a member.
 */
export function NotificationPreviewButton({
  template,
  form,
}: {
  template: NotificationTemplate;
  form: FormInstance;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(() => samplesFor(template.variables));
  const [invalid, setInvalid] = useState<string | null>(null);
  const preview = useRouteMutation(notificationAdminTemplatePreview, { presentError: false });
  const { mutate, reset } = preview;

  const readChannels = (): NotificationChannels | null => {
    const values = form.getFieldsValue(true) as { channels?: unknown };
    const parsed = notificationChannels.safeParse(values.channels ?? {});
    if (parsed.success) {
      setInvalid(null);
      return parsed.data;
    }
    setInvalid(`表单还有没填对的地方：${parsed.error.issues[0]?.message ?? '请检查表单'}`);
    return null;
  };

  const run = (): void => {
    const channels = readChannels();
    if (channels) mutate({ params: { code: template.code }, body: { channels, data } });
  };

  const result = preview.data;
  return (
    <>
      <Button
        onClick={() => {
          // Preview straight away: the samples are already filled in.
          setOpen(true);
          run();
        }}
        data-testid="notification-preview"
      >
        预览{template.audience === 'user' ? ' / 测试发送' : ''}
      </Button>
      <Modal
        open={open}
        title={`预览：${template.name}`}
        width={820}
        onCancel={() => setOpen(false)}
        afterClose={() => {
          reset();
          setInvalid(null);
        }}
        destroyOnHidden
        footer={<Button onClick={() => setOpen(false)}>关闭</Button>}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            按表单里当前的内容渲染（包括还没保存的修改）。示例数据可以改，改完点「刷新预览」。
          </Typography.Text>

          {template.variables.length > 0 ? (
            <Row gutter={[12, 8]}>
              {template.variables.map((name) => (
                <Col key={name} xs={24} sm={12} md={8}>
                  <Input
                    addonBefore={name}
                    value={data[name] ?? ''}
                    onChange={(event) => setData({ ...data, [name]: event.target.value })}
                    aria-label={name}
                  />
                </Col>
              ))}
            </Row>
          ) : null}
          <Button type="primary" loading={preview.isPending} onClick={run}>
            刷新预览
          </Button>

          {invalid ? <Alert type="warning" showIcon message={invalid} /> : null}
          {preview.error ? (
            <Alert
              type="error"
              showIcon
              message={errorMessage(preview.error, '预览失败，请重试')}
            />
          ) : null}
          {result ? <PreviewResult result={result} /> : null}

          {template.audience === 'user' ? (
            <TestSend
              template={template}
              data={data}
              readChannels={readChannels}
              channels={TEST_CHANNELS.filter((c) => template.supportedChannels.includes(c))}
            />
          ) : null}
        </Space>
      </Modal>
    </>
  );
}

function PreviewResult({ result }: { result: NotificationTemplatePreview }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }} data-testid="notification-preview-result">
      {result.warnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`已启用的渠道有 ${result.warnings.length} 个问题`}
          description={
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          }
        />
      ) : (
        <Alert type="success" showIcon message="已启用的渠道都没有发现问题" />
      )}

      {result.inApp ? (
        <ChannelCard channel="inApp" enabled={result.inApp.enabled}>
          <Typography.Text strong>{result.inApp.title}</Typography.Text>
          <Typography.Paragraph style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>
            {result.inApp.content}
          </Typography.Paragraph>
          <Opens value={result.inApp.opens} empty="不跳转" />
        </ChannelCard>
      ) : null}

      {result.wechatOa ? (
        <ChannelCard channel="wechatOa" enabled={result.wechatOa.enabled}>
          <Fields fields={result.wechatOa.fields} />
          <Opens value={result.wechatOa.url} empty="不跳转" />
        </ChannelCard>
      ) : null}

      {result.wechatMini ? (
        <ChannelCard channel="wechatMini" enabled={result.wechatMini.enabled}>
          <Fields fields={result.wechatMini.fields} />
          <Opens value={result.wechatMini.page} empty="小程序首页" />
        </ChannelCard>
      ) : null}

      {result.sms ? (
        <ChannelCard channel="sms" enabled={result.sms.enabled}>
          <Typography.Text type="secondary">
            {SMS_PROVIDER[result.sms.provider]} · 模板 {result.sms.templateCode || '（未填）'}
            {result.sms.signName ? ` · 签名【${result.sms.signName}】` : ''}
            。短信正文是服务商审核通过的模板，下面是按顺序实际交给服务商的全部变量：
          </Typography.Text>
          {result.sms.params.length === 0 ? (
            <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
              不传任何变量（适用于没有变量的模板）
            </Typography.Paragraph>
          ) : (
            <Fields fields={result.sms.params} />
          )}
        </ChannelCard>
      ) : null}
    </Space>
  );
}

function ChannelCard({
  channel,
  enabled,
  children,
}: {
  channel: keyof typeof NOTIFICATION_CHANNEL;
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <Card
      size="small"
      title={NOTIFICATION_CHANNEL[channel].label}
      extra={enabled ? <Tag color="success">已启用</Tag> : <Tag>未启用</Tag>}
      style={enabled ? {} : { opacity: 0.7 }}
    >
      {children}
    </Card>
  );
}

function Fields({ fields }: { fields: readonly { key: string; value: string }[] }) {
  if (fields.length === 0)
    return <Typography.Text type="secondary">（没有可发送的字段）</Typography.Text>;
  return (
    <Descriptions
      size="small"
      bordered
      column={1}
      style={{ marginTop: 8 }}
      items={fields.map((field) => ({ key: field.key, label: field.key, children: field.value }))}
    />
  );
}

function Opens({ value, empty }: { value: string | null; empty: string }) {
  return (
    <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
      点击打开：{value === null ? empty : <Typography.Text code>{value}</Typography.Text>}
    </Typography.Paragraph>
  );
}

/**
 * 测试发送: one real message to one member. The channel goes out even with its
 * switch off, which is what testing before 启用 means — so it asks first, and
 * says when it costs money.
 */
function TestSend({
  template,
  data,
  readChannels,
  channels,
}: {
  template: NotificationTemplate;
  data: Record<string, string>;
  readChannels: () => NotificationChannels | null;
  channels: NotificationTestChannel[];
}) {
  const can = useCan();
  const [channel, setChannel] = useState<NotificationTestChannel | null>(channels[0] ?? null);
  const [userId, setUserId] = useState<number | null>(null);
  const send = useRouteMutation(notificationAdminTemplateTestSend, { presentError: false });

  if (channels.length === 0 || !can('notification:template:write')) return null;

  const run = (): void => {
    const current = readChannels();
    if (!current || channel === null || userId === null) return;
    send.mutate({
      params: { code: template.code },
      body: { channels: current, data, channel, userId: String(userId) },
    });
  };

  const result = send.data;
  return (
    <>
      <Divider style={{ margin: '4px 0' }} />
      <Typography.Text strong>测试发送</Typography.Text>
      <Typography.Text type="secondary">
        用上面的示例数据，给一个会员真实发一条（通常填你自己的会员 ID，在「用户」列表里能查到）。
        渠道没启用也会发。
      </Typography.Text>
      <Space wrap>
        <Select<NotificationTestChannel>
          value={channel}
          onChange={(next) => {
            setChannel(next);
            send.reset();
          }}
          options={channels.map((value) => ({ value, label: NOTIFICATION_CHANNEL[value].label }))}
          style={{ width: 120 }}
          aria-label="测试渠道"
        />
        <InputNumber<number>
          value={userId}
          onChange={setUserId}
          min={1}
          precision={0}
          placeholder="会员 ID"
          style={{ width: 160 }}
          aria-label="会员 ID"
        />
        <Popconfirm
          title="确定真实发送？"
          description={
            channel === 'sms'
              ? `会给会员 ${userId ?? ''} 的手机发一条短信，按条计费`
              : `会给会员 ${userId ?? ''} 发一条${channel ? NOTIFICATION_CHANNEL[channel].label : ''}消息`
          }
          okText="发送"
          onConfirm={run}
          disabled={userId === null}
        >
          <Button
            disabled={userId === null}
            loading={send.isPending}
            data-testid="notification-test-send"
          >
            发送
          </Button>
        </Popconfirm>
      </Space>
      {send.error ? (
        <Alert type="error" showIcon message={errorMessage(send.error, '发送失败，请重试')} />
      ) : null}
      {result ? (
        <Alert
          type={
            result.outcome === 'sent'
              ? 'success'
              : result.outcome === 'skipped'
                ? 'warning'
                : 'error'
          }
          showIcon
          message={result.message}
          data-testid="notification-test-send-result"
        />
      ) : null}
    </>
  );
}
