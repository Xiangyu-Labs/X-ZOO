'use client';

import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { DECOR_LIMITS, PRODUCT_SORT, type ProductSort } from '@shop/contracts/decor/constants';
import type {
  ArticleSource,
  CouponSource,
  GroupbuySource,
  PresaleSource,
  ProductSource,
} from '@shop/contracts/decor/sources';
import { Avatar, Button, InputNumber, List, Segmented, Select, Space, Typography } from 'antd';
import { useState, type ReactNode } from 'react';

import { RECORD_KIND_LABELS, type DecorRecordKind } from '../records';
import {
  CategoryTreeSelect,
  RecordPickerModal,
  SingleRecordPicker,
  useResolvedRecords,
} from './record-picker';
import { FieldShell, type DecorFieldProps } from './shell';

/**
 * The data-source controls (`productSource`, `couponSource`, `groupbuySource`,
 * `presaleSource`, `articleSource`): a mode switch, then either a hand-picked,
 * ordered list of records or the rule's settings.
 */

// ─── a hand-picked list ──────────────────────────────────────────────────────

export function ManualRecords({
  kind,
  ids,
  max,
  onChange,
  readOnly = false,
}: {
  kind: DecorRecordKind;
  ids: readonly string[];
  max: number;
  onChange: (ids: string[]) => void;
  readOnly?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { rows, isPending, isError } = useResolvedRecords(kind, ids);
  const label = RECORD_KIND_LABELS[kind];
  const move = (from: number, to: number) => {
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(to, 0, moved);
    onChange(next);
  };
  return (
    <>
      <List
        size="small"
        bordered
        loading={isPending}
        locale={{ emptyText: `未选择${label}` }}
        dataSource={ids.map((id, index) => ({ id, index, row: rows[index] }))}
        renderItem={({ id, index, row }) => (
          <List.Item
            style={{ paddingInline: 8 }}
            actions={[
              <Button
                key="up"
                size="small"
                type="text"
                icon={<ArrowUpOutlined />}
                aria-label="上移"
                disabled={readOnly || index === 0}
                onClick={() => move(index, index - 1)}
              />,
              <Button
                key="down"
                size="small"
                type="text"
                icon={<ArrowDownOutlined />}
                aria-label="下移"
                disabled={readOnly || index === ids.length - 1}
                onClick={() => move(index, index + 1)}
              />,
              <Button
                key="remove"
                size="small"
                type="text"
                icon={<DeleteOutlined />}
                aria-label="移除"
                disabled={readOnly}
                onClick={() => onChange(ids.filter((_other, at) => at !== index))}
              />,
            ]}
          >
            <Space size={6} style={{ minWidth: 0 }}>
              {row?.image ? <Avatar shape="square" size={24} src={row.image} /> : null}
              {row ? (
                <Typography.Text ellipsis style={{ maxWidth: 120 }}>
                  {row.name}
                </Typography.Text>
              ) : (
                <Typography.Text type={isError ? 'danger' : 'warning'}>
                  #{id}
                  {isPending ? '' : isError ? '（加载失败）' : '（已不可用）'}
                </Typography.Text>
              )}
            </Space>
          </List.Item>
        )}
      />
      <Button
        block
        size="small"
        icon={<PlusOutlined />}
        style={{ marginTop: 8 }}
        disabled={readOnly || ids.length >= max}
        onClick={() => setOpen(true)}
      >
        添加{label}（{ids.length}/{max}）
      </Button>
      <RecordPickerModal
        kind={kind}
        open={open}
        chosen={ids}
        onClose={() => setOpen(false)}
        onPick={(record) => {
          if (ids.length < max && !ids.includes(record.id)) onChange([...ids, record.id]);
        }}
      />
    </>
  );
}

function ModeSwitch<M extends string>({
  value,
  modes,
  onChange,
  readOnly,
}: {
  value: M;
  modes: Readonly<Record<M, string>>;
  onChange: (mode: M) => void;
  readOnly: boolean;
}) {
  return (
    <Segmented
      block
      size="small"
      disabled={readOnly}
      value={value}
      options={(Object.entries(modes) as [M, string][]).map(([mode, label]) => ({
        value: mode,
        label,
      }))}
      onChange={(mode) => onChange(mode as M)}
    />
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      {children}
    </div>
  );
}

function LimitInput({
  value,
  max,
  onChange,
  readOnly,
}: {
  value: number;
  max: number;
  onChange: (limit: number) => void;
  readOnly: boolean;
}) {
  return (
    <Labelled label="显示数量">
      <InputNumber
        size="small"
        min={1}
        max={max}
        precision={0}
        value={value}
        disabled={readOnly}
        style={{ width: '100%' }}
        onChange={(limit) => onChange(Math.min(max, Math.max(1, limit ?? 1)))}
      />
    </Labelled>
  );
}

// ─── products ────────────────────────────────────────────────────────────────

const PRODUCT_MODES = { manual: '手动选择', category: '按分类', label: '按标签' } as const;

export function ProductSourceField({
  field,
  name,
  value,
  onChange,
  readOnly = false,
}: DecorFieldProps<ProductSource | undefined>) {
  const current: ProductSource = value ?? { mode: 'manual', ids: [] };
  const sort = current.mode === 'manual' ? 'default' : current.sort;
  const limit = current.mode === 'manual' ? 6 : current.limit;
  return (
    <FieldShell field={field} name={name} readOnly={readOnly}>
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <ModeSwitch
          value={current.mode}
          modes={PRODUCT_MODES}
          readOnly={readOnly}
          onChange={(mode) =>
            onChange(
              mode === 'manual'
                ? { mode, ids: [] }
                : mode === 'category'
                  ? { mode, categoryId: '', sort, limit }
                  : { mode, labelId: '', sort, limit },
            )
          }
        />
        {current.mode === 'manual' ? (
          <ManualRecords
            kind="product"
            ids={current.ids}
            max={DECOR_LIMITS.manualProducts}
            readOnly={readOnly}
            onChange={(ids) => onChange({ mode: 'manual', ids })}
          />
        ) : (
          <>
            {current.mode === 'category' ? (
              <Labelled label="商品分类">
                <CategoryTreeSelect
                  tree="product"
                  value={current.categoryId || undefined}
                  readOnly={readOnly}
                  onChange={(categoryId) => onChange({ ...current, categoryId: categoryId ?? '' })}
                />
              </Labelled>
            ) : (
              <Labelled label="商品标签">
                <SingleRecordPicker
                  kind="label"
                  value={current.labelId || undefined}
                  readOnly={readOnly}
                  onChange={(labelId) => onChange({ ...current, labelId })}
                />
              </Labelled>
            )}
            <Labelled label="排序">
              <Select<ProductSort>
                size="small"
                style={{ width: '100%' }}
                value={current.sort}
                disabled={readOnly}
                options={Object.entries(PRODUCT_SORT).map(([key, label]) => ({
                  value: key as ProductSort,
                  label,
                }))}
                onChange={(next) => onChange({ ...current, sort: next })}
              />
            </Labelled>
            <LimitInput
              value={current.limit}
              max={DECOR_LIMITS.autoProducts}
              readOnly={readOnly}
              onChange={(next) => onChange({ ...current, limit: next })}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按规则自动取已上架、有库存的商品，随商品变化自动更新。
            </Typography.Text>
          </>
        )}
      </Space>
    </FieldShell>
  );
}

// ─── coupons, group-buys, presales ───────────────────────────────────────────

type AutoSource = CouponSource | GroupbuySource | PresaleSource;

const AUTO_HINTS: Record<'coupon' | 'groupbuy' | 'presale', string> = {
  coupon: '自动取当前可领取的优惠券，顺序同领券中心。',
  groupbuy: '自动取正在进行的拼团活动，顺序同拼团列表。',
  presale: '自动取未结束的预售活动，顺序同预售列表。',
};

function autoSourceField(kind: 'coupon' | 'groupbuy' | 'presale') {
  return function AutoSourceField({
    field,
    name,
    value,
    onChange,
    readOnly = false,
  }: DecorFieldProps<AutoSource | undefined>) {
    const current: AutoSource = value ?? { mode: 'manual', ids: [] };
    return (
      <FieldShell field={field} name={name} readOnly={readOnly}>
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <ModeSwitch
            value={current.mode}
            modes={{ manual: '手动选择', auto: '自动' }}
            readOnly={readOnly}
            onChange={(mode) =>
              onChange(mode === 'manual' ? { mode, ids: [] } : { mode, limit: 3 })
            }
          />
          {current.mode === 'manual' ? (
            <ManualRecords
              kind={kind}
              ids={current.ids}
              max={DECOR_LIMITS.records}
              readOnly={readOnly}
              onChange={(ids) => onChange({ mode: 'manual', ids })}
            />
          ) : (
            <>
              <LimitInput
                value={current.limit}
                max={DECOR_LIMITS.records}
                readOnly={readOnly}
                onChange={(limit) => onChange({ mode: 'auto', limit })}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {AUTO_HINTS[kind]}
              </Typography.Text>
            </>
          )}
        </Space>
      </FieldShell>
    );
  };
}

export const CouponSourceField = autoSourceField('coupon');
export const GroupbuySourceField = autoSourceField('groupbuy');
export const PresaleSourceField = autoSourceField('presale');

// ─── articles ────────────────────────────────────────────────────────────────

export function ArticleSourceField({
  field,
  name,
  value,
  onChange,
  readOnly = false,
}: DecorFieldProps<ArticleSource | undefined>) {
  const current: ArticleSource = value ?? { mode: 'manual', ids: [] };
  return (
    <FieldShell field={field} name={name} readOnly={readOnly}>
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <ModeSwitch
          value={current.mode}
          modes={{ manual: '手动选择', category: '按分类' }}
          readOnly={readOnly}
          onChange={(mode) => onChange(mode === 'manual' ? { mode, ids: [] } : { mode, limit: 3 })}
        />
        {current.mode === 'manual' ? (
          <ManualRecords
            kind="article"
            ids={current.ids}
            max={DECOR_LIMITS.records}
            readOnly={readOnly}
            onChange={(ids) => onChange({ mode: 'manual', ids })}
          />
        ) : (
          <>
            <Labelled label="资讯分类">
              <CategoryTreeSelect
                tree="article"
                value={current.categoryId}
                allowClear
                placeholder="全部分类"
                readOnly={readOnly}
                onChange={(categoryId) => {
                  const { categoryId: _drop, ...rest } = current;
                  onChange(categoryId ? { ...rest, categoryId } : rest);
                }}
              />
            </Labelled>
            <LimitInput
              value={current.limit}
              max={DECOR_LIMITS.records}
              readOnly={readOnly}
              onChange={(limit) => onChange({ ...current, limit })}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按发布时间从新到旧自动取已发布的资讯。
            </Typography.Text>
          </>
        )}
      </Space>
    </FieldShell>
  );
}
