'use client';

import { App, Button, Input, Typography } from 'antd';
import { useState } from 'react';
import { z } from 'zod';
import { id } from '@shop/contracts';
import {
  couponAdminCreate,
  couponAdminDelete,
  couponAdminDetail,
  couponAdminGrant,
  couponAdminList,
  couponAdminSetStatus,
  couponAdminUpdate,
} from '@shop/contracts/coupon/coupon.admin.contract';
import {
  couponTemplateForm,
  type CouponTemplateDetail,
  type CouponTemplateListItem,
} from '@shop/contracts/coupon/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  enumColumn,
  idColumn,
  instantColumn,
  moneyColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { StatusToggleButton } from '@/admin/kit/status-toggle-button';
import { Can } from '@/admin/session/can';

import { COUPON_CLAIM_MODE, COUPON_SCOPE, COUPON_STATUS, couponFields } from '../coupon-enums';

/**
 * 优惠券列表 — the admin page the other 150 are meant to look like.
 *
 * Everything on this page comes from the kit and the contract:
 *
 *  - no `fetch`: `CrudTable` calls the route, and paging / sorting / filters
 *    live in the URL, so a filtered list is a link you can send a colleague;
 *  - no hand-written validation: `ModalForm` takes the contract's own body
 *    schema, including the cross-field rules that mirror the database CHECKs;
 *  - no permission logic beyond `<Can>` and `permission=`, which only hide
 *    things — the server re-checks the atom declared on each route.
 */
export function CouponTemplatesPage() {
  // The edit form loads the whole template first. The list row has
  // no `productIds` / `categoryIds`, and this page renders no control for
  // either, so a form seeded from the row would post the schema's `[]` default
  // and silently unlink every product a scoped coupon applied to.
  const modal = useFormModal<CouponTemplateListItem, typeof couponAdminDetail>({
    detail: {
      route: couponAdminDetail,
      params: (row) => ({ id: row.id }),
      select: initialValuesOf,
    },
  });
  const [granting, setGranting] = useState<CouponTemplateListItem | null>(null);

  return (
    <PageContainer subTitle="营销活动的优惠券模板；已领取的券在「已领取记录」里查">
      <CrudTable
        route={couponAdminList}
        scrollX={1400}
        filters={[
          { kind: 'text', name: 'keyword', label: '名称' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            multiple: true,
            options: Object.entries(COUPON_STATUS).map(([value, option]) => ({
              value,
              label: option.label,
            })),
          },
          {
            kind: 'select',
            name: 'claimMode',
            label: '发放方式',
            options: Object.entries(COUPON_CLAIM_MODE).map(([value, option]) => ({
              value,
              label: option.label,
            })),
          },
        ]}
        toolbar={
          <Can permission="coupon:template:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建优惠券
            </Button>
          </Can>
        }
        columns={[
          idColumn<CouponTemplateListItem>({ sortable: true }),
          textColumn<CouponTemplateListItem>({
            title: '名称',
            dataIndex: 'name',
            ellipsis: true,
            sortable: true,
          }),
          moneyColumn<CouponTemplateListItem>({
            title: '面额',
            dataIndex: 'discountAmount',
            sortable: true,
          }),
          moneyColumn<CouponTemplateListItem>({ title: '门槛', dataIndex: 'minSpend' }),
          enumColumn<CouponTemplateListItem, CouponTemplateListItem['scope']>({
            title: '适用范围',
            dataIndex: 'scope',
            map: COUPON_SCOPE,
          }),
          enumColumn<CouponTemplateListItem, CouponTemplateListItem['claimMode']>({
            title: '发放方式',
            dataIndex: 'claimMode',
            map: COUPON_CLAIM_MODE,
          }),
          {
            title: '库存 / 已发',
            key: 'supply',
            width: 140,
            render: (_value: unknown, row: CouponTemplateListItem) => (
              <Typography.Text>
                {row.isUnlimitedSupply ? '不限量' : `剩 ${row.remainingCount ?? 0}`}
                <Typography.Text type="secondary"> / 已发 {row.issuedCount}</Typography.Text>
              </Typography.Text>
            ),
          },
          {
            title: '状态',
            key: 'status',
            width: 100,
            render: (_value: unknown, row: CouponTemplateListItem) => (
              <StatusTag value={row.status} map={COUPON_STATUS} />
            ),
          },
          instantColumn<CouponTemplateListItem>({
            title: '创建时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          actionsColumn<CouponTemplateListItem>({
            width: 220,
            render: (row) => (
              <>
                <Can permission="coupon:template:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                  <StatusToggleButton
                    route={couponAdminSetStatus}
                    on={row.status === 'active'}
                    input={(next) => ({
                      params: { id: row.id },
                      body: { status: next ? ('active' as const) : ('disabled' as const) },
                    })}
                    confirmTitle={`停用优惠券「${row.name}」？`}
                    confirmDescription="停用后买家不能再领取；已领到的券不受影响。"
                    invalidate={[couponAdminList]}
                  />
                </Can>
                <Can permission="coupon:grant:write">
                  <Button type="link" size="small" onClick={() => setGranting(row)}>
                    发放
                  </Button>
                </Can>
                <ConfirmButton
                  route={couponAdminDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除优惠券「${row.name}」？`}
                  description="已领取的优惠券不受影响，仍可正常使用。"
                  invalidate={[couponAdminList]}
                  successMessage="已删除"
                  permission="coupon:template:delete"
                  buttonProps={{ type: 'link', size: 'small', danger: true }}
                >
                  删除
                </ConfirmButton>
              </>
            ),
          }),
        ]}
      />

      <ModalForm
        {...modal.props}
        title={modal.record ? `编辑：${modal.record.name}` : '新建优惠券'}
        size="large"
        columns={2}
        schema={couponTemplateForm}
        fields={couponFields}
        route={modal.record ? couponAdminUpdate : couponAdminCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[couponAdminList]}
        successMessage="已保存"
      />

      <GrantModal template={granting} onClose={() => setGranting(null)} />
    </PageContainer>
  );
}

/**
 * The detail minus the fields the form does not own (`remainingCount`,
 * `issuedCount`, `createdAt`), with `null` turned into `undefined`:
 * `exactOptionalPropertyTypes` means an optional field is either absent or a
 * real value, never `null`.
 *
 * `productIds` and `categoryIds` are carried through even though no control
 * renders them: they are part of the update body, so leaving them out means
 * sending `[]`. They ride in the form's initial values, which antd keeps in
 * its store whether or not a field registers for them, and come back out of
 * `onFinish` unchanged.
 */
function initialValuesOf(row: CouponTemplateDetail) {
  return {
    productIds: row.productIds,
    categoryIds: row.categoryIds,
    name: row.name,
    scope: row.scope,
    claimMode: row.claimMode,
    status: row.status,
    discountAmount: row.discountAmount,
    minSpend: row.minSpend,
    validityMode: row.validityMode,
    ...(row.validFrom === null ? {} : { validFrom: row.validFrom }),
    ...(row.validTo === null ? {} : { validTo: row.validTo }),
    ...(row.validDays === null ? {} : { validDays: row.validDays }),
    ...(row.claimFrom === null ? {} : { claimFrom: row.claimFrom }),
    ...(row.claimTo === null ? {} : { claimTo: row.claimTo }),
    isUnlimitedSupply: row.isUnlimitedSupply,
    ...(row.totalCount === null ? {} : { totalCount: row.totalCount }),
    ...(row.perUserLimit === null ? {} : { perUserLimit: row.perUserLimit }),
    ...(row.giftMinOrderAmount === null ? {} : { giftMinOrderAmount: row.giftMinOrderAmount }),
    sortOrder: row.sortOrder,
  };
}

/**
 * 发放给指定用户.
 *
 * Deliberately a plain textarea of user ids rather than a user picker: an
 * operator pasting a list out of a spreadsheet is the actual workflow. The
 * result reports how many were skipped for already holding the maximum, which is
 * normal when a group overlaps a previous grant.
 */
const MAX_GRANT_IDS = 200;

/** Whitespace, commas (either width) and 、 all separate; a repeated id counts once. */
function parseUserIds(raw: string): string[] {
  return [...new Set(raw.split(/[\s,，、]+/).filter(Boolean))];
}

const grantForm = z.object({
  userIds: z
    .string()
    .trim()
    .min(1, '请填写至少一个用户 ID')
    .superRefine((raw, ctx) => {
      const ids = parseUserIds(raw);
      const malformed = ids.filter((value) => !id.safeParse(value).success);
      if (malformed.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `用户 ID 是数字，这些不是：${malformed.slice(0, 3).join('、')}${malformed.length > 3 ? ' 等' : ''}`,
        });
      } else if (ids.length > MAX_GRANT_IDS) {
        ctx.addIssue({
          code: 'custom',
          message: `一次最多 ${MAX_GRANT_IDS} 个用户 ID，现在有 ${ids.length} 个`,
        });
      }
    }),
});

/** The textarea, and how many ids it holds as the operator pastes. */
function UserIdsInput({
  value,
  onChange,
  disabled,
  id: inputId,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  id?: string | undefined;
}) {
  const text = typeof value === 'string' ? value : '';
  const count = parseUserIds(text).length;
  return (
    <>
      <Input.TextArea
        id={inputId}
        rows={6}
        value={text}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="1001 1002 1003"
      />
      <Typography.Text type={count > MAX_GRANT_IDS ? 'danger' : 'secondary'}>
        已识别 {count} 个用户 ID（上限 {MAX_GRANT_IDS}）
      </Typography.Text>
    </>
  );
}

function GrantModal({
  template,
  onClose,
}: {
  template: CouponTemplateListItem | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  return (
    <ModalForm
      open={template !== null}
      onClose={onClose}
      title={template ? `发放：${template.name}` : '发放优惠券'}
      size="small"
      okText="发放"
      schema={grantForm}
      fields={[
        {
          kind: 'custom',
          name: 'userIds',
          label: '用户 ID',
          help: '粘贴用户 ID，空格、逗号或换行分隔。库存不足时整批不发放。',
          render: (props) => <UserIdsInput {...props} />,
        },
      ]}
      route={couponAdminGrant}
      toInput={(values) => ({
        params: { id: template?.id ?? '' },
        body: { userIds: parseUserIds(values.userIds) },
      })}
      invalidate={[couponAdminList]}
      onSuccess={(result) => {
        void message.success(
          result.skippedUserIds.length === 0
            ? `已发放 ${result.granted} 张`
            : `已发放 ${result.granted} 张，${result.skippedUserIds.length} 位用户已达上限`,
        );
      }}
    />
  );
}
