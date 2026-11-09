'use client';

import {
  Alert,
  Button,
  Collapse,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Typography,
} from 'antd';
import { cloneElement, isValidElement, useState, type ReactNode } from 'react';
import type {
  ProductPromotionAdmin,
  ProductPromotionInput,
  ProductPromotionSettings,
} from '@shop/contracts/catalog/promotion';
import type { ProductSkuInput } from '@shop/contracts/catalog/schemas';
import { DateField } from '@/admin/kit/form/date-fields';
import { MoneyInput } from '@/admin/kit/form/money-input';
import type { SelectOption } from '@/admin/kit/form/types';
import { AssetField } from '@/admin/kit/form/asset-field';

const keyOf = (values: Record<string, string>) =>
  JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
const names = { normal: '普通商品', presale: '预售商品', groupbuy: '拼单商品' };

export function promotionInputOf(state: ProductPromotionAdmin | undefined): ProductPromotionInput {
  const chosen = state?.candidates.find(
    (item) => item.kind === state.mode && item.activityId === state.activityId,
  );
  return {
    mode: state?.mode ?? 'normal',
    expectedVersion: state?.version ?? 0,
    ...(chosen
      ? { activityId: chosen.activityId, ...(chosen.settings ? { settings: chosen.settings } : {}) }
      : {}),
  };
}

/** A controlled field inside the product's single form and atomic save. */
export function ProductPromotionField({
  value,
  onChange,
  skus,
  state,
  disabled,
  canPresale,
  canGroupbuy,
  shippingOptions,
}: {
  value?: ProductPromotionInput | undefined;
  onChange: (value: ProductPromotionInput) => void;
  skus: readonly ProductSkuInput[];
  state?: ProductPromotionAdmin | undefined;
  disabled: boolean;
  canPresale: boolean;
  canGroupbuy: boolean;
  shippingOptions: readonly SelectOption[];
}) {
  const current = value ?? promotionInputOf(state);
  const mode = current.mode;
  const [fillPrice, setFillPrice] = useState<string | undefined>();
  const [readAt] = useState(() => Date.now());
  const mayEdit =
    !disabled && (mode === 'normal' || (mode === 'presale' ? canPresale : canGroupbuy));
  const settings: ProductPromotionSettings = current.settings ?? { endAt: '', skus: [] };
  const priceLabel = mode === 'presale' ? '预售价' : '拼单价';
  const hiddenSettings =
    !!current.activityId &&
    !state?.candidates.find((item) => item.activityId === current.activityId && item.kind === mode)
      ?.settings;
  const ended = state?.candidates.some(
    (candidate) =>
      candidate.activityId === current.activityId &&
      candidate.kind === current.mode &&
      (candidate.status === 'ended' ||
        (candidate.settings && Date.parse(candidate.settings.endAt) <= readAt)),
  );
  const bySpec = new Map(settings.skus.map((sku) => [keyOf(sku.specValues), sku]));
  const rows = skus.map((sku) => ({ ...sku, activity: bySpec.get(keyOf(sku.specValues)) }));
  const activitySkus = () =>
    rows.map((row) => row.activity ?? { specValues: row.specValues, price: '', stock: row.stock });
  const changeSettings = (patch: Partial<ProductPromotionSettings>) =>
    onChange({ ...current, settings: { ...settings, skus: activitySkus(), ...patch } });
  const changeMode = (next: ProductPromotionInput['mode']) => {
    const old = state?.candidates.find(
      (item) => item.kind === next && item.activityId === state.activityId,
    );
    onChange({
      mode: next,
      expectedVersion: current.expectedVersion,
      ...(old
        ? { activityId: old.activityId, ...(old.settings ? { settings: old.settings } : {}) }
        : next === 'normal'
          ? {}
          : {
              settings: {
                endAt: '',
                shipAfterDays: 0,
                seatsRequired: 2,
                skus: skus.map((sku) => ({
                  specValues: sku.specValues,
                  price: '',
                  stock: sku.stock,
                })),
              },
            }),
    });
  };
  const patchSku = (index: number, patch: Partial<ProductPromotionSettings['skus'][number]>) => {
    const next = activitySkus();
    next[index] = { ...next[index]!, ...patch };
    changeSettings({ skus: next });
  };
  const field = (label: string, control: ReactNode) => (
    <div style={{ minWidth: 180 }}>
      <label htmlFor={`product-promotion-${label}`} style={{ display: 'block', marginBottom: 8 }}>
        {label}
      </label>
      {isValidElement<{ id?: string }>(control)
        ? cloneElement(control, { id: `product-promotion-${label}` })
        : control}
    </div>
  );

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Space>
          <Switch
            aria-label="是否为预售商品"
            checked={mode === 'presale'}
            disabled={disabled || !canPresale || (mode === 'groupbuy' && !canGroupbuy)}
            onChange={(checked) => changeMode(checked ? 'presale' : 'normal')}
          />
          是否为预售商品
        </Space>
        <Space>
          <Switch
            aria-label="是否为拼单商品"
            checked={mode === 'groupbuy'}
            disabled={disabled || !canGroupbuy || (mode === 'presale' && !canPresale)}
            onChange={(checked) => changeMode(checked ? 'groupbuy' : 'normal')}
          />
          是否为拼单商品
        </Space>
        <Typography.Text type="secondary">
          预售与拼单只能选择一种，当前为{names[mode]}
        </Typography.Text>
      </Space>
      {state?.conflict ? (
        <>
          <Alert
            type="warning"
            showIcon
            title="此商品存在多个活动，请选择保留的活动；保存后其余活动将停止接受新订单。"
          />
          <Select
            aria-label="选择保留的活动"
            placeholder="请选择保留的活动"
            style={{ minWidth: 300 }}
            disabled={disabled}
            value={current.activityId ? `${mode}:${current.activityId}` : null}
            options={state.candidates.map((item) => ({
              value: `${item.kind}:${item.activityId}`,
              label: `${names[item.kind]}：${item.title}`,
              disabled: item.kind === 'presale' ? !canPresale : !canGroupbuy,
            }))}
            onChange={(key: string) => {
              const item = state.candidates.find(
                (candidate) => `${candidate.kind}:${candidate.activityId}` === key,
              );
              if (item?.settings)
                onChange({
                  mode: item.kind,
                  activityId: item.activityId,
                  expectedVersion: current.expectedVersion,
                  settings: item.settings,
                });
            }}
          />
        </>
      ) : null}
      {hiddenSettings ? (
        <Alert type="info" title="当前身份没有查看此活动设置的权限，保存商品时将保留原活动配置。" />
      ) : null}
      {mode !== 'normal' && !hiddenSettings ? (
        <>
          {ended ? (
            <Alert type="info" title="原活动已结束，重新设置未来结束时间并保存将创建新活动。" />
          ) : null}
          {!mayEdit ? (
            <Alert type="info" title="当前身份不能修改此活动设置，保存商品时将保留原活动配置。" />
          ) : null}
          <Space wrap align="start">
            {field(
              mode === 'presale' ? '预售结束时间' : '拼单活动结束时间',
              <DateField
                value={settings.endAt || undefined}
                onChange={(endAt) => changeSettings({ endAt: endAt ?? '' })}
                showTime
                endOfDay
                disabled={!mayEdit}
              />,
            )}
            {mode === 'presale'
              ? field(
                  '付款后发货天数',
                  <InputNumber<number>
                    aria-label="付款后发货天数"
                    min={0}
                    max={365}
                    precision={0}
                    value={settings.shipAfterDays ?? null}
                    disabled={!mayEdit}
                    onChange={(days) => changeSettings({ shipAfterDays: days ?? undefined })}
                    addonAfter="天内发货"
                  />,
                )
              : field(
                  '成团总人数（含发起人）',
                  <InputNumber<number>
                    aria-label="成团总人数"
                    min={2}
                    max={100}
                    precision={0}
                    value={settings.seatsRequired ?? null}
                    disabled={!mayEdit}
                    onChange={(seats) => changeSettings({ seatsRequired: seats ?? undefined })}
                  />,
                )}
          </Space>
          <Space wrap>
            <MoneyInput
              aria-label={`批量${priceLabel}`}
              value={fillPrice}
              onChange={setFillPrice}
              disabled={!mayEdit}
            />
            <Button
              disabled={!mayEdit || !fillPrice}
              onClick={() =>
                changeSettings({
                  skus: activitySkus().map((sku) => ({ ...sku, price: fillPrice! })),
                })
              }
            >
              批量填写{priceLabel}
            </Button>
          </Space>
          <Table
            pagination={false}
            size="small"
            rowKey={(row) => keyOf(row.specValues)}
            dataSource={rows}
            columns={[
              {
                title: '规格',
                render: (_unused, row) => Object.values(row.specValues).join(' / ') || '默认规格',
              },
              { title: '单独购买价', dataIndex: 'price', render: (price: string) => `¥${price}` },
              {
                title: priceLabel,
                render: (_unused, row, index) => (
                  <MoneyInput
                    aria-label={`${Object.values(row.specValues).join(' / ') || '默认规格'}${priceLabel}`}
                    value={row.activity?.price}
                    disabled={!mayEdit}
                    onChange={(price) => patchSku(index, { price: price ?? '' })}
                  />
                ),
              },
            ]}
          />
          <Collapse
            items={[
              {
                key: 'advanced',
                label: '高级设置',
                children: (
                  <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                    <Space wrap align="start">
                      {field(
                        '活动划线价（留空不展示）',
                        <MoneyInput
                          value={settings.originalPrice ?? undefined}
                          disabled={!mayEdit}
                          onChange={(originalPrice) =>
                            changeSettings({ originalPrice: originalPrice ?? null })
                          }
                        />,
                      )}
                      {mode === 'groupbuy'
                        ? field(
                            '活动成本价（留空不记录）',
                            <MoneyInput
                              value={settings.cost ?? undefined}
                              disabled={!mayEdit}
                              onChange={(cost) => changeSettings({ cost: cost ?? null })}
                            />,
                          )
                        : null}
                      {field(
                        '活动标题',
                        <Input
                          value={settings.title}
                          disabled={!mayEdit}
                          onChange={(event) => changeSettings({ title: event.target.value })}
                        />,
                      )}
                      {field(
                        '活动简介',
                        <Input
                          value={settings.intro ?? ''}
                          disabled={!mayEdit}
                          allowClear
                          onChange={(event) =>
                            changeSettings({ intro: event.target.value || null })
                          }
                        />,
                      )}
                      {field(
                        '开始时间（留空保存即开始）',
                        <DateField
                          value={settings.startAt ?? undefined}
                          showTime
                          disabled={!mayEdit}
                          onChange={(startAt) => changeSettings({ startAt: startAt ?? null })}
                        />,
                      )}
                      {field(
                        '活动状态',
                        <Select
                          aria-label="活动状态"
                          value={settings.status ?? 'active'}
                          style={{ width: 160 }}
                          disabled={!mayEdit}
                          options={[
                            { value: 'active', label: '开启' },
                            { value: 'paused', label: '暂停' },
                            { value: 'draft', label: '草稿' },
                          ]}
                          onChange={(status) => changeSettings({ status })}
                        />,
                      )}
                      {field(
                        '活动库存',
                        <InputNumber<number>
                          aria-label="活动库存"
                          min={0}
                          max={1_000_000}
                          precision={0}
                          value={settings.stock ?? null}
                          placeholder="默认各活动规格库存之和"
                          disabled={!mayEdit}
                          onChange={(stock) => changeSettings({ stock: stock ?? undefined })}
                        />,
                      )}
                      {field(
                        '活动总限购量（留空不限）',
                        <InputNumber<number>
                          aria-label="活动总限购量"
                          min={0}
                          max={1_000_000}
                          precision={0}
                          value={settings.totalQuota ?? null}
                          disabled={!mayEdit}
                          onChange={(totalQuota) => changeSettings({ totalQuota })}
                        />,
                      )}
                      {field(
                        '每单限购',
                        <InputNumber<number>
                          aria-label="每单限购"
                          min={1}
                          max={999}
                          precision={0}
                          value={settings.perOrderQuantity ?? 999}
                          disabled={!mayEdit}
                          onChange={(perOrderQuantity) =>
                            changeSettings({ perOrderQuantity: perOrderQuantity ?? undefined })
                          }
                        />,
                      )}
                      {mode === 'groupbuy'
                        ? field(
                            '拼团有效时长（小时）',
                            <InputNumber<number>
                              aria-label="拼团有效时长"
                              min={1 / 60}
                              max={720}
                              value={(settings.groupTtlSeconds ?? 86400) / 3600}
                              disabled={!mayEdit}
                              onChange={(hours) =>
                                changeSettings({
                                  groupTtlSeconds:
                                    hours === null ? undefined : Math.round(hours * 3600),
                                })
                              }
                            />,
                          )
                        : null}
                      {field(
                        '运费模板（留空沿用商品）',
                        <Select
                          aria-label="活动运费模板"
                          allowClear
                          showSearch
                          optionFilterProp="label"
                          value={settings.shippingTemplateId ?? null}
                          style={{ minWidth: 220 }}
                          options={shippingOptions.map((option) => ({
                            label: option.label,
                            value: String(option.value),
                            disabled: option.disabled === true,
                          }))}
                          disabled={!mayEdit}
                          onChange={(shippingTemplateId: string | undefined) =>
                            changeSettings({ shippingTemplateId: shippingTemplateId ?? null })
                          }
                        />,
                      )}
                      {field(
                        '排序',
                        <InputNumber<number>
                          min={0}
                          max={9999}
                          precision={0}
                          value={settings.sortOrder ?? 0}
                          disabled={!mayEdit}
                          onChange={(sortOrder) => changeSettings({ sortOrder: sortOrder ?? 0 })}
                        />,
                      )}
                    </Space>
                    {field(
                      '活动主图',
                      <AssetField
                        value={settings.imageUrl}
                        disabled={!mayEdit}
                        onChange={(imageUrl) =>
                          changeSettings({
                            imageUrl: typeof imageUrl === 'string' ? imageUrl : null,
                          })
                        }
                      />,
                    )}
                    {field(
                      '活动轮播图',
                      <AssetField
                        multiple
                        max={10}
                        value={settings.sliderImages}
                        disabled={!mayEdit}
                        onChange={(images) =>
                          changeSettings({
                            sliderImages: Array.isArray(images) ? (images as string[]) : [],
                          })
                        }
                      />,
                    )}
                    <Table
                      pagination={false}
                      size="small"
                      rowKey={(row) => keyOf(row.specValues)}
                      dataSource={rows}
                      columns={[
                        {
                          title: '规格',
                          render: (_unused, row) =>
                            Object.values(row.specValues).join(' / ') || '默认规格',
                        },
                        {
                          title: '活动库存',
                          render: (_unused, row, index) => (
                            <InputNumber<number>
                              aria-label={`${Object.values(row.specValues).join(' / ') || '默认规格'}活动库存`}
                              value={row.activity?.stock ?? row.stock}
                              min={0}
                              max={1_000_000}
                              precision={0}
                              disabled={!mayEdit}
                              onChange={(stock) => patchSku(index, { stock: stock ?? undefined })}
                            />
                          ),
                        },
                        {
                          title: '限购量（留空不限）',
                          render: (_unused, row, index) => (
                            <InputNumber<number>
                              value={row.activity?.quota ?? null}
                              min={0}
                              max={1_000_000}
                              precision={0}
                              disabled={!mayEdit}
                              onChange={(quota) => patchSku(index, { quota })}
                            />
                          ),
                        },
                        {
                          title: '参与活动',
                          render: (_unused, row, index) => (
                            <Switch
                              checked={row.activity?.isEnabled ?? true}
                              disabled={!mayEdit}
                              onChange={(isEnabled) => patchSku(index, { isEnabled })}
                            />
                          ),
                        },
                      ]}
                    />
                  </Space>
                ),
              },
            ]}
          />
        </>
      ) : null}
    </Space>
  );
}
