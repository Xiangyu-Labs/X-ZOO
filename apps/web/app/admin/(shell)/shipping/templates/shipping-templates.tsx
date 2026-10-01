'use client';

import { Button, InputNumber, Space, Tag, Typography } from 'antd';
import {
  shippingTemplateCreate,
  shippingTemplateDelete,
  shippingTemplateDetailRoute,
  shippingTemplateList,
  shippingTemplateUpdate,
} from '@shop/contracts/shipping/shipping.template.admin.contract';
import {
  shippingTemplateForm,
  type ShippingTemplateFreeRule,
  type ShippingTemplateListItem,
  type ShippingTemplateRegion,
} from '@shop/contracts/shipping/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { MoneyInput } from '@/admin/kit/form/money-input';
import { TreeSelectField } from '@/admin/kit/form/select-fields';
import { DrawerForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { statusOptions } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  enumColumn,
  idColumn,
  instantColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

import { SHIPPING_CHARGE_MODE } from '../shipping-enums';
import { loadCityOptions } from './city-options';
import { FreightTrialButton } from './freight-trial';

/**
 * 运费模板.
 *
 * The form is the whole template — head, priced regions, free-shipping rules
 * and the no-delivery list — because that is how the domain writes it: one
 * transaction that replaces every child row. Submitting half a template is not
 * a state the server has.
 *
 * The cross-field rules (exactly one 「默认全国」 region, no cities on it, a
 * threshold on every free rule) come from the contract's own schema, so the
 * form refuses what the database would have refused.
 */

function CityPicker(props: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <TreeSelectField
      multiple
      value={props.value}
      onChange={(next) => props.onChange(Array.isArray(next) ? next : next ? [next] : [])}
      loadOptions={loadCityOptions}
      cacheKey="shipping.cities"
      placeholder={props.placeholder}
      disabled={props.disabled ?? false}
    />
  );
}

export function ShippingTemplatesPage() {
  // The list row carries no rules, so the drawer loads the detail it edits —
  // and mounts the form only once it has it.
  const drawer = useFormModal<ShippingTemplateListItem, typeof shippingTemplateDetailRoute>({
    detail: { route: shippingTemplateDetailRoute, params: (row) => ({ id: row.id }) },
  });
  const editing = drawer.record;

  return (
    <PageContainer subTitle="商品选中的模板决定运费；未命中任何地区规则时按「默认全国」计算">
      <CrudTable
        route={shippingTemplateList}
        filters={[
          { kind: 'text', name: 'keyword', label: '名称' },
          {
            kind: 'select',
            name: 'chargeMode',
            label: '计费方式',
            options: statusOptions(SHIPPING_CHARGE_MODE),
          },
        ]}
        toolbar={
          <Can permission="shipping:template:write">
            <Button type="primary" onClick={() => drawer.show()}>
              新建模板
            </Button>
          </Can>
        }
        columns={[
          idColumn<ShippingTemplateListItem>({ sortable: true }),
          textColumn<ShippingTemplateListItem>({
            title: '名称',
            dataIndex: 'name',
            ellipsis: true,
          }),
          enumColumn<ShippingTemplateListItem>({
            title: '计费方式',
            dataIndex: 'chargeMode',
            map: SHIPPING_CHARGE_MODE,
          }),
          {
            title: '规则',
            key: 'rules',
            width: 180,
            render: (_value: unknown, row: ShippingTemplateListItem) => (
              <Space size={4}>
                {row.hasFreeRules ? <Tag color="green">包邮规则</Tag> : null}
                {row.hasNoDeliveryRules ? <Tag color="orange">不配送</Tag> : null}
              </Space>
            ),
          },
          {
            title: '使用商品',
            dataIndex: 'productCount',
            key: 'productCount',
            width: 100,
          },
          { title: '排序', dataIndex: 'sortOrder', key: 'sortOrder', width: 90, sorter: true },
          instantColumn<ShippingTemplateListItem>({ title: '更新时间', dataIndex: 'updatedAt' }),
          actionsColumn<ShippingTemplateListItem>({
            render: (row) => (
              <>
                <Can permission="shipping:template:write">
                  <Button type="link" size="small" onClick={() => drawer.show(row)}>
                    编辑
                  </Button>
                </Can>
                <ConfirmButton
                  route={shippingTemplateDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除运费模板「${row.name}」？`}
                  description="仍被商品使用的模板无法删除。"
                  invalidate={[shippingTemplateList]}
                  successMessage="已删除"
                  permission="shipping:template:delete"
                  buttonProps={{ type: 'link', size: 'small', danger: true }}
                >
                  删除
                </ConfirmButton>
              </>
            ),
          }),
        ]}
      />

      <DrawerForm
        {...drawer.props}
        size="large"
        title={editing ? '编辑运费模板' : '新建运费模板'}
        schema={shippingTemplateForm}
        fields={[
          { kind: 'text', name: 'name', label: '模板名称', span: 12 },
          {
            kind: 'radio',
            name: 'chargeMode',
            label: '计费方式',
            span: 12,
            optionType: 'button',
            options: statusOptions(SHIPPING_CHARGE_MODE),
          },
          { kind: 'number', name: 'sortOrder', label: '排序', span: 12, min: 0, max: 9999 },
          {
            kind: 'sortableList',
            name: 'regions',
            label: '地区运费',
            help: '第一条是「默认全国」，其余按地区覆盖；同一地址命中多条时取最细的一条',
            addText: '添加地区规则',
            newItem: () => ({
              isFallback: false,
              cityIds: [],
              firstUnit: 1,
              firstPrice: '0.00',
              additionalUnit: 1,
              additionalPrice: '0.00',
            }),
            renderItem: (raw: never, helpers) => {
              const item = raw as unknown as ShippingTemplateRegion;
              const update = (patch: Partial<ShippingTemplateRegion>) =>
                helpers.set({ ...item, ...patch } as unknown as never);
              return (
                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                  {item.isFallback ? (
                    <Tag color="blue">默认全国</Tag>
                  ) : (
                    <CityPicker
                      value={item.cityIds}
                      onChange={(cityIds) => update({ cityIds })}
                      placeholder="选择省 / 市 / 区"
                    />
                  )}
                  <Space wrap size={8}>
                    <span>首</span>
                    <InputNumber
                      min={0}
                      value={item.firstUnit}
                      onChange={(value) => update({ firstUnit: value ?? 0 })}
                      style={{ width: 90 }}
                    />
                    <span>运费</span>
                    <MoneyInput
                      value={item.firstPrice}
                      onChange={(value) => update({ firstPrice: value ?? '0.00' })}
                    />
                    <span>续</span>
                    <InputNumber
                      min={0}
                      value={item.additionalUnit}
                      onChange={(value) => update({ additionalUnit: value ?? 0 })}
                      style={{ width: 90 }}
                    />
                    <span>运费</span>
                    <MoneyInput
                      value={item.additionalPrice}
                      onChange={(value) => update({ additionalPrice: value ?? '0.00' })}
                    />
                  </Space>
                  <Typography.Text type="secondary">
                    续费单位填 0 表示不再续费，超出首件部分仍按首费收取
                  </Typography.Text>
                </Space>
              );
            },
          },
          { kind: 'switch', name: 'hasFreeRules', label: '启用包邮规则', span: 12 },
          {
            kind: 'sortableList',
            name: 'freeRules',
            label: '包邮规则',
            visibleWhen: (values) => values.hasFreeRules === true,
            help: '件数/重量与金额同时满足才包邮，留空表示该条件不参与判断',
            addText: '添加包邮规则',
            newItem: () => ({ cityIds: [], minUnits: null, minAmount: null }),
            renderItem: (raw: never, helpers) => {
              const item = raw as unknown as ShippingTemplateFreeRule;
              const update = (patch: Partial<ShippingTemplateFreeRule>) =>
                helpers.set({ ...item, ...patch } as unknown as never);
              return (
                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                  <CityPicker
                    value={item.cityIds}
                    onChange={(cityIds) => update({ cityIds })}
                    placeholder="选择包邮地区"
                  />
                  <Space wrap size={8}>
                    <span>满</span>
                    <InputNumber
                      min={0}
                      value={item.minUnits}
                      onChange={(value) => update({ minUnits: value })}
                      style={{ width: 110 }}
                      placeholder="不限"
                    />
                    <span>且满</span>
                    <MoneyInput
                      value={item.minAmount ?? undefined}
                      onChange={(value) => update({ minAmount: value ? value : null })}
                    />
                  </Space>
                </Space>
              );
            },
          },
          { kind: 'switch', name: 'hasNoDeliveryRules', label: '启用不配送地区', span: 12 },
          {
            kind: 'custom',
            name: 'noDeliveryCityIds',
            label: '不配送地区',
            visibleWhen: (values) => values.hasNoDeliveryRules === true,
            help: '下单时收货地址命中这些地区会被拒绝，并提示哪个商品不支持配送',
            render: ({ value, onChange, disabled }) => (
              <CityPicker
                value={Array.isArray(value) ? (value as string[]) : []}
                onChange={onChange}
                placeholder="选择不配送的地区"
                disabled={disabled}
              />
            ),
          },
        ]}
        initialValues={
          editing
            ? undefined
            : {
                chargeMode: 'quantity',
                sortOrder: 0,
                hasFreeRules: false,
                hasNoDeliveryRules: false,
                freeRules: [],
                noDeliveryCityIds: [],
                regions: [
                  {
                    isFallback: true,
                    cityIds: [],
                    firstUnit: 1,
                    firstPrice: '0.00',
                    additionalUnit: 1,
                    additionalPrice: '0.00',
                  },
                ],
              }
        }
        route={editing ? shippingTemplateUpdate : shippingTemplateCreate}
        toInput={(values) =>
          editing ? { params: { id: editing.id }, body: values } : { body: values }
        }
        invalidate={[shippingTemplateList]}
        successMessage="已保存"
        footerExtra={(form) => <FreightTrialButton form={form} />}
      />
    </PageContainer>
  );
}
