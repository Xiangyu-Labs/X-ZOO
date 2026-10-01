'use client';

import {
  Alert,
  Button,
  Form,
  InputNumber,
  List,
  Modal,
  Space,
  Tag,
  Typography,
  type FormInstance,
} from 'antd';
import { useState } from 'react';
import { shippingTemplateTrial } from '@shop/contracts/shipping/shipping.template.admin.contract';
import {
  shippingTemplateForm,
  type ShippingChargeMode,
  type ShippingTemplateTrialResult,
} from '@shop/contracts/shipping/schemas';

import { errorMessage } from '@/admin/api/errors';
import { useRouteMutation } from '@/admin/api/hooks';
import { MoneyInput } from '@/admin/kit/form/money-input';
import { TreeSelectField } from '@/admin/kit/form/select-fields';

import { loadCityOptions } from './city-options';

const UNIT: Record<ShippingChargeMode, string> = { quantity: '件', weight: 'kg', volume: 'm³' };

const OUTCOME: Record<ShippingTemplateTrialResult['outcome'], { color: string; text: string }> = {
  charged: { color: 'blue', text: '收运费' },
  'free-by-rule': { color: 'green', text: '模板包邮' },
  'free-by-threshold': { color: 'green', text: '全店满额包邮' },
  undeliverable: { color: 'red', text: '不配送' },
};

interface TrialInput {
  cityId?: string;
  units?: number | null;
  amount?: string | null;
}

/**
 * 运费试算 in the template drawer: the template as it stands in the form —
 * saved or not — priced for one product to one address, with the rule that
 * decided it. The server prices it with checkout's own function.
 */
export function FreightTrialButton({ form }: { form: FormInstance }) {
  const [open, setOpen] = useState(false);
  const [inputs] = Form.useForm<TrialInput>();
  const [invalid, setInvalid] = useState<string | null>(null);
  const trial = useRouteMutation(shippingTemplateTrial, { presentError: false });
  const chargeMode =
    (Form.useWatch('chargeMode', form) as ShippingChargeMode | undefined) ?? 'quantity';

  const run = async (): Promise<void> => {
    const input = await inputs.validateFields();
    const parsed = shippingTemplateForm.safeParse(form.getFieldsValue(true));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setInvalid(`模板还没填完整：${issue?.message ?? '请检查表单'}`);
      return;
    }
    setInvalid(null);
    trial.mutate({
      body: {
        template: parsed.data,
        cityId: input.cityId ?? '',
        units: input.units ?? 0,
        amount: input.amount ?? '0.00',
      },
    });
  };

  const result = trial.data;
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="freight-trial">
        运费试算
      </Button>
      <Modal
        open={open}
        title="运费试算"
        onCancel={() => setOpen(false)}
        destroyOnHidden
        afterClose={() => {
          trial.reset();
          setInvalid(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>关闭</Button>
            <Button type="primary" loading={trial.isPending} onClick={() => run()}>
              试算
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            按表单里当前的规则计算（包括还没保存的修改），一件商品寄到一个地址。
          </Typography.Text>
          <Form form={inputs} layout="vertical" initialValues={{ units: 1, amount: '0.00' }}>
            <Form.Item
              name="cityId"
              label="收货地区"
              rules={[{ required: true, message: '请选择收货地区' }]}
            >
              <TreeSelectField
                loadOptions={loadCityOptions}
                cacheKey="shipping.cities"
                placeholder="选择省 / 市 / 区，选到区县最准确"
              />
            </Form.Item>
            <Space size="large" wrap>
              <Form.Item
                name="units"
                label={
                  chargeMode === 'quantity' ? '件数' : chargeMode === 'weight' ? '重量' : '体积'
                }
                rules={[{ required: true, message: '请填写' }]}
              >
                <InputNumber
                  min={0.01}
                  precision={2}
                  suffix={UNIT[chargeMode]}
                  style={{ width: 160 }}
                />
              </Form.Item>
              <Form.Item name="amount" label="商品金额" extra="包邮规则和全店满额包邮按它判断">
                <MoneyInput />
              </Form.Item>
            </Space>
          </Form>

          {invalid ? <Alert type="warning" showIcon message={invalid} /> : null}
          {trial.error ? (
            <Alert type="error" showIcon message={errorMessage(trial.error, '试算失败，请重试')} />
          ) : null}

          {result ? (
            <div data-testid="freight-trial-result">
              <Space align="baseline" size={12}>
                <Typography.Title level={3} style={{ margin: 0 }}>
                  ¥{result.fee}
                </Typography.Title>
                <Tag color={OUTCOME[result.outcome].color}>{OUTCOME[result.outcome].text}</Tag>
              </Space>
              <List
                size="small"
                style={{ marginTop: 12 }}
                bordered
                dataSource={result.steps}
                renderItem={(step, index) => (
                  <List.Item>
                    <Typography.Text>
                      {index + 1}. {step}
                    </Typography.Text>
                  </List.Item>
                )}
              />
            </div>
          ) : null}
        </Space>
      </Modal>
    </>
  );
}
