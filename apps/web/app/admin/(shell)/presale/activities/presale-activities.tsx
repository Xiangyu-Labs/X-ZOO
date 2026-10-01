'use client';

import { Button, Typography } from 'antd';
import {
  presaleAdminActivityCreate,
  presaleAdminActivityDelete,
  presaleAdminActivityDetail,
  presaleAdminActivityList,
  presaleAdminActivitySetStatus,
  presaleAdminActivityUpdate,
} from '@shop/contracts/presale/presale.admin.contract';
import {
  presaleActivityForm,
  type PresaleActivityDetail,
  type PresaleActivityListItem,
} from '@shop/contracts/presale/schemas';
import type { z } from 'zod';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
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

import { ActivityStatusTag } from '../../groupbuy/activity-window';
import { PRESALE_ACTIVITY_STATUS, PRESALE_PAYMENT_MODE, presaleFields } from '../presale-enums';

/**
 * 预售活动.
 *
 * Everything on this page comes from the kit and the contract: `CrudTable`
 * calls the route and keeps paging, sorting and filters in the URL; `ModalForm`
 * takes the contract's own body schema, including `endAt > startAt` and the
 * duplicate-SKU check; `<Can>` and `permission=` only hide things, and the
 * server re-checks the atom declared on each route.
 *
 * 启用/暂停 is one click because that is the operation an operator performs in a
 * hurry — a campaign priced wrong has to stop selling now, not after a modal.
 * 结束 is deliberately not offered: `ended` is terminal, it is what the window
 * sweep writes when the campaign's own end time passes, and an operator who
 * wants it gone sooner moves the end time or deletes it.
 */
export function PresaleActivitiesPage() {
  // `detail` is the kit's: the edit dialog loads the whole activity
  // before it renders a single field. `presaleAdminActivityUpdate` takes a
  // whole activity, and the list row carries neither `skus` nor
  // `sliderImages` — a form opened on the row would submit an empty 规格 list
  // and delete every presale price on the campaign.
  const modal = useFormModal<PresaleActivityListItem, typeof presaleAdminActivityDetail>({
    detail: {
      route: presaleAdminActivityDetail,
      params: (row) => ({ id: row.id }),
      select: initialValuesOf,
    },
  });

  const open = (row?: PresaleActivityListItem) => modal.show(row);

  return (
    <PageContainer subTitle="全款预售：付款后按承诺天数发货；预售库存与商品库存各记各的">
      <CrudTable
        route={presaleAdminActivityList}
        scrollX={1500}
        filters={[
          { kind: 'text', name: 'keyword', label: '标题' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            multiple: true,
            options: Object.entries(PRESALE_ACTIVITY_STATUS).map(([value, option]) => ({
              value,
              label: option.label,
            })),
          },
          { kind: 'number', name: 'productId', label: '商品 ID', min: 1 },
        ]}
        toolbar={
          <Can permission="presale:activity:write">
            <Button type="primary" onClick={() => open()}>
              新建预售活动
            </Button>
          </Can>
        }
        columns={[
          idColumn<PresaleActivityListItem>({ sortable: true }),
          textColumn<PresaleActivityListItem>({
            title: '活动标题',
            dataIndex: 'title',
            ellipsis: true,
          }),
          textColumn<PresaleActivityListItem>({
            title: '商品',
            dataIndex: 'productName',
            ellipsis: true,
          }),
          moneyColumn<PresaleActivityListItem>({ title: '预售价', dataIndex: 'price' }),
          {
            title: '库存 / 已售',
            key: 'supply',
            width: 160,
            render: (_value: unknown, row: PresaleActivityListItem) => (
              <Typography.Text>
                剩 {row.stock}
                <Typography.Text type="secondary"> / 已售 {row.sales}</Typography.Text>
                {row.totalQuota === null ? null : (
                  <Typography.Text type="secondary"> / 限 {row.totalQuota}</Typography.Text>
                )}
              </Typography.Text>
            ),
          },
          {
            title: '发货承诺',
            key: 'shipAfterDays',
            width: 130,
            render: (_value: unknown, row: PresaleActivityListItem) =>
              row.shipAfterDays === 0 ? '付款后即发' : `付款后 ${row.shipAfterDays} 天内`,
          },
          instantColumn<PresaleActivityListItem>({
            title: '开始时间',
            dataIndex: 'startAt',
            sortable: true,
          }),
          instantColumn<PresaleActivityListItem>({ title: '结束时间', dataIndex: 'endAt' }),
          enumColumn<PresaleActivityListItem, PresaleActivityListItem['paymentMode']>({
            title: '付款方式',
            dataIndex: 'paymentMode',
            map: PRESALE_PAYMENT_MODE,
          }),
          {
            title: '状态',
            key: 'status',
            width: 100,
            render: (_value: unknown, row: PresaleActivityListItem) => (
              <ActivityStatusTag row={row} map={PRESALE_ACTIVITY_STATUS} />
            ),
          },
          actionsColumn<PresaleActivityListItem>({
            width: 180,
            render: (row) => (
              <>
                <Can permission="presale:activity:write">
                  <Button type="link" size="small" onClick={() => open(row)}>
                    编辑
                  </Button>
                  {row.status === 'ended' ? null : (
                    <StatusToggleButton
                      route={presaleAdminActivitySetStatus}
                      on={row.status === 'active'}
                      input={(next) => ({
                        params: { id: row.id },
                        body: { status: next ? ('active' as const) : ('paused' as const) },
                      })}
                      labels={['启用', '暂停']}
                      confirmTitle={`暂停预售「${row.title}」？`}
                      confirmDescription="暂停后商城下架这个预售，买家不能再下单。"
                      invalidate={[presaleAdminActivityList]}
                    />
                  )}
                </Can>
                <ConfirmButton
                  route={presaleAdminActivityDelete}
                  input={{ params: { id: row.id } }}
                  title="确认删除该预售活动？"
                  description="还有未完成预售订单时无法删除；已完成的订单不受影响。"
                  invalidate={[presaleAdminActivityList]}
                  successMessage="已删除"
                  permission="presale:activity:delete"
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
        title={modal.record ? `编辑：${modal.record.title}` : '新建预售活动'}
        size="large"
        columns={2}
        schema={presaleActivityForm}
        fields={presaleFields}
        route={modal.record ? presaleAdminActivityUpdate : presaleAdminActivityCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[presaleAdminActivityList, presaleAdminActivityDetail]}
        successMessage="已保存"
      />
    </PageContainer>
  );
}

/**
 * The detail row as the form's values: the server's own fields minus the ones
 * it owns (`sales`, `productName`, `createdAt`), with `null` turned into
 * `undefined` — `exactOptionalPropertyTypes` means an optional field is either
 * absent or a real value, never `null`.
 *
 * The declared return type is what keeps it honest: `EntityFormLoad['select']`
 * is a plain record, because the controller that carries it does not know the
 * body schema, so this annotation is where a field that stops existing on the
 * form is a compile error rather than a value the form drops on save.
 */
function initialValuesOf(row: PresaleActivityDetail): Partial<z.input<typeof presaleActivityForm>> {
  return {
    productId: row.productId,
    title: row.title,
    ...(row.intro === null ? {} : { intro: row.intro }),
    ...(row.imageUrl === null ? {} : { imageUrl: row.imageUrl }),
    sliderImages: row.sliderImages,
    status: row.status,
    paymentMode: 'full' as const,
    price: row.price,
    ...(row.originalPrice === null ? {} : { originalPrice: row.originalPrice }),
    stock: row.stock,
    expectedStock: row.stock,
    ...(row.totalQuota === null ? {} : { totalQuota: row.totalQuota }),
    perOrderQuantity: row.perOrderQuantity,
    startAt: row.startAt,
    endAt: row.endAt,
    shipAfterDays: row.shipAfterDays,
    ...(row.shippingTemplateId === null ? {} : { shippingTemplateId: row.shippingTemplateId }),
    sortOrder: row.sortOrder,
    skus: row.skus.map((sku) => ({
      skuId: sku.skuId,
      price: sku.price,
      stock: sku.stock,
      expectedStock: sku.stock,
      ...(sku.quota === null ? {} : { quota: sku.quota }),
      isEnabled: sku.isEnabled,
    })),
  };
}
