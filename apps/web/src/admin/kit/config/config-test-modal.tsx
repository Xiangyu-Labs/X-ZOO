'use client';

import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { Alert, Button, Form, List, Modal, Space, Typography, theme } from 'antd';
import { useState, type ReactNode } from 'react';

import type { ConfigFieldDescriptor, ConfigTestDescriptor, ConfigValues } from './types';

export interface ConfigTestStep {
  name: string;
  ok: boolean;
  detail?: string | undefined;
  ms?: number | undefined;
}

export interface ConfigTestOutcome {
  ok: boolean;
  steps: ConfigTestStep[];
}

export interface ConfigTestModalProps {
  open: boolean;
  onClose: () => void;
  test: ConfigTestDescriptor;
  /** Whether the form holds unsaved changes, which the test will use. */
  dirty: boolean;
  running: boolean;
  /** Set once a run came back; cleared by the caller when the modal reopens. */
  outcome: ConfigTestOutcome | null;
  /** A refusal of the request itself (422, 429), not a failed step. */
  error: string | null;
  onRun: (input: ConfigValues) => void;
  renderControl: (field: ConfigFieldDescriptor) => ReactNode;
}

/**
 * 「测试」: the inputs the test needs, the warning when it costs money, and then
 * each step with a tick or a cross and whatever the provider said.
 *
 * A failed step is the answer the operator came for, not an error, so it shows
 * as a result in the list; only a refused request (bad phone number, too many
 * tests) shows as an alert.
 */
export function ConfigTestModal({
  open,
  onClose,
  test,
  dirty,
  running,
  outcome,
  error,
  onRun,
  renderControl,
}: ConfigTestModalProps) {
  const [form] = Form.useForm();
  const [confirming, setConfirming] = useState(false);
  const { token } = theme.useToken();

  // Closing drops a pending confirmation, so the next open asks again.
  const close = (): void => {
    setConfirming(false);
    onClose();
  };

  const start = async (): Promise<void> => {
    const input = (await form.validateFields()) as ConfigValues;
    if (test.confirm && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onRun(input);
  };

  return (
    <Modal
      open={open}
      title={test.label}
      onCancel={close}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={close}>关闭</Button>
          <Button type="primary" danger={confirming} loading={running} onClick={() => start()}>
            {confirming ? '确定，开始测试' : outcome ? '再测一次' : '开始测试'}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          {dirty
            ? '使用当前表单里的值（包括还没保存的修改）；密钥框留空的，使用已保存的密钥。测试不会保存任何配置。'
            : '使用当前已保存的配置。测试不会修改任何配置。'}
        </Typography.Text>

        {/* Always mounted, so `validateFields` has a form even when there are no inputs. */}
        <Form form={form} layout="vertical" disabled={running}>
          {test.inputs.map((field) => (
            <Form.Item
              key={field.key}
              name={field.key}
              label={field.label}
              extra={field.help}
              rules={
                test.optional?.includes(field.key)
                  ? []
                  : [{ required: true, message: `请填写${field.label}` }]
              }
            >
              {renderControl(field)}
            </Form.Item>
          ))}
        </Form>

        {confirming && test.confirm ? (
          <Alert type="warning" showIcon message={test.confirm} />
        ) : null}

        {error ? <Alert type="error" showIcon message={error} /> : null}

        {outcome ? (
          <>
            <Alert
              type={outcome.ok ? 'success' : 'error'}
              showIcon
              message={outcome.ok ? '测试通过' : '测试未通过'}
              {...(outcome.ok && dirty
                ? { description: '这些值还没有保存，关闭后记得点「保存」。' }
                : {})}
            />
            <List
              size="small"
              bordered
              dataSource={outcome.steps}
              renderItem={(step) => (
                <List.Item
                  extra={
                    step.ms === undefined ? null : (
                      <Typography.Text type="secondary">{step.ms} ms</Typography.Text>
                    )
                  }
                >
                  <List.Item.Meta
                    avatar={
                      step.ok ? (
                        <CheckCircleFilled style={{ color: token.colorSuccess, fontSize: 16 }} />
                      ) : (
                        <CloseCircleFilled style={{ color: token.colorError, fontSize: 16 }} />
                      )
                    }
                    title={step.name}
                    description={
                      step.detail ? (
                        <Typography.Text
                          type={step.ok ? 'secondary' : 'danger'}
                          style={{ wordBreak: 'break-all' }}
                          copyable={!step.ok}
                        >
                          {step.detail}
                        </Typography.Text>
                      ) : null
                    }
                  />
                </List.Item>
              )}
            />
          </>
        ) : null}
      </Space>
    </Modal>
  );
}
