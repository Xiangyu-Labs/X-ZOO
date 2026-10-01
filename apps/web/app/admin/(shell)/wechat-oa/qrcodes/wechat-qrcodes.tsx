'use client';

import { Button, Typography } from 'antd';
import { useState } from 'react';
import {
  wechatOaQrcodeCategoryList,
  wechatOaQrcodeCreate,
  wechatOaQrcodeDelete,
  wechatOaQrcodeList,
  wechatOaQrcodeSetStatus,
  wechatOaQrcodeUpdate,
} from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import {
  wechatQrcodeForm,
  type WechatQrcode,
  type WechatQrcodeForm,
} from '@shop/contracts/wechat-oa/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import type { FieldSpec, SelectOption } from '@/admin/kit/form/types';
import { PageContainer } from '@/admin/kit/page-container';
import { statusOptions } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  enumColumn,
  idColumn,
  imageColumn,
  instantColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { StatusToggleButton } from '@/admin/kit/status-toggle-button';
import { Can } from '@/admin/session/can';
import { QrcodeStatisticDrawer } from '@/admin/wechat-oa/qrcode-statistic-drawer';

import { QRCODE_STATUS, REPLY_TYPE, replyBodyFields } from '../wechat-oa-enums';

type FormKey = Extract<keyof WechatQrcodeForm, string>;
/** The create form's keys minus the two a channel code can never change. */
type EditKey = Exclude<FormKey, 'scene' | 'expireSeconds'>;

/**
 * 渠道二维码 — a poster with a scene string on it.
 *
 * The scene string is the whole point: WeChat echoes it back on every scan, and
 * the webhook attributes the scan (and any follow that came with it) to this
 * row. It is therefore **not editable** — the poster is already printed and on
 * a wall somewhere, and re-pointing the scene would silently re-attribute
 * every future scan of it. The edit form only offers the label, the filing and
 * the greeting, which is why it uses the contract's own `omit`ed body.
 */
export function WechatQrcodesPage() {
  const modal = useFormModal<WechatQrcode>();
  const [viewing, setViewing] = useState<WechatQrcode | null>(null);

  const categories = useRouteQuery(wechatOaQrcodeCategoryList, {
    query: { page: 1, pageSize: 100 },
  });
  const categoryOptions: SelectOption[] = (categories.data?.items ?? []).map((item) => ({
    value: item.id,
    label: item.name,
  }));

  const editing = modal.record;

  return (
    <PageContainer subTitle="每张海报一个场景值；扫码和涨粉都按场景值归因，生成后不可更改">
      <CrudTable
        route={wechatOaQrcodeList}
        scrollX={1400}
        filters={[
          { kind: 'text', name: 'keyword', label: '关键词', placeholder: '名称或场景值' },
          {
            kind: 'select',
            name: 'categoryId',
            label: '分类',
            options: categoryOptions,
          },
          { kind: 'select', name: 'status', label: '状态', options: statusOptions(QRCODE_STATUS) },
        ]}
        toolbar={
          <Can permission="wechat-oa:qrcode:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建渠道码
            </Button>
          </Can>
        }
        columns={[
          idColumn<WechatQrcode>(),
          imageColumn<WechatQrcode>({ title: '二维码', dataIndex: 'imageUrl', size: 56 }),
          textColumn<WechatQrcode>({ title: '名称', dataIndex: 'name', ellipsis: true }),
          {
            title: '场景值',
            key: 'scene',
            width: 140,
            render: (_value: unknown, row: WechatQrcode) => (
              <Typography.Text code copyable>
                {row.scene}
              </Typography.Text>
            ),
          },
          textColumn<WechatQrcode>({
            title: '分类',
            dataIndex: 'categoryName',
            placeholder: '未分类',
            width: 120,
          }),
          {
            title: '扫码次数',
            dataIndex: 'scanCount',
            key: 'scanCount',
            width: 110,
            sorter: true,
            showSorterTooltip: false,
          },
          {
            title: '新增关注',
            dataIndex: 'followCount',
            key: 'followCount',
            width: 110,
            sorter: true,
            showSorterTooltip: false,
          },
          enumColumn<WechatQrcode, WechatQrcode['status']>({
            title: '状态',
            dataIndex: 'status',
            map: QRCODE_STATUS,
            width: 90,
          }),
          instantColumn<WechatQrcode>({
            title: '创建时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          actionsColumn<WechatQrcode>({
            width: 210,
            render: (row) => (
              <>
                <Button type="link" size="small" onClick={() => setViewing(row)}>
                  统计
                </Button>
                <Can permission="wechat-oa:qrcode:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                  <StatusToggleButton
                    route={wechatOaQrcodeSetStatus}
                    on={row.status === 'active'}
                    input={(next) => ({
                      params: { id: row.id },
                      body: { status: next ? ('active' as const) : ('disabled' as const) },
                    })}
                    confirmTitle={`停用渠道码「${row.name}」？`}
                    invalidate={[wechatOaQrcodeList]}
                  />
                </Can>
                <ConfirmButton
                  route={wechatOaQrcodeDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除渠道码「${row.name}」？`}
                  description="已经印出去的海报还会被扫到，但扫码将不再归因到任何渠道。"
                  invalidate={[wechatOaQrcodeList]}
                  successMessage="已删除"
                  permission="wechat-oa:qrcode:write"
                  buttonProps={{ type: 'link', size: 'small', danger: true }}
                >
                  删除
                </ConfirmButton>
              </>
            ),
          }),
        ]}
      />

      {/* Two different schemas, so two components — and distinct keys, because
          React would otherwise reuse the one antd `Form` instance and the
          second dialog would open holding the first one's values. */}
      {editing ? (
        <ModalForm
          key="edit"
          {...modal.props}
          title={`编辑：${editing.name}`}
          columns={2}
          schema={wechatQrcodeForm.omit({ scene: true, expireSeconds: true })}
          fields={editFields(categoryOptions)}
          initialValues={{
            name: editing.name,
            ...(editing.categoryId === null ? {} : { categoryId: editing.categoryId }),
            ...(editing.replyType === null ? {} : { replyType: editing.replyType }),
            ...(editing.replyPayload === null ? {} : { replyPayload: editing.replyPayload }),
          }}
          route={wechatOaQrcodeUpdate}
          toInput={(values) => ({ params: { id: editing.id }, body: values })}
          invalidate={[wechatOaQrcodeList]}
          successMessage="已保存"
        />
      ) : (
        <ModalForm
          key="create"
          {...modal.props}
          title="新建渠道码"
          columns={2}
          schema={wechatQrcodeForm}
          fields={createFields(categoryOptions)}
          route={wechatOaQrcodeCreate}
          invalidate={[wechatOaQrcodeList]}
          successMessage="已生成，可以下载图片了"
        />
      )}

      <QrcodeStatisticDrawer qrcode={viewing} onClose={() => setViewing(null)} />
    </PageContainer>
  );
}

/** The label and the filing, which both forms have. */
function labelFields(categoryOptions: SelectOption[]): FieldSpec<EditKey>[] {
  return [
    { kind: 'text', name: 'name', label: '名称', span: 12, maxLength: 100 },
    {
      kind: 'select',
      name: 'categoryId',
      label: '分类',
      span: 12,
      options: categoryOptions,
      placeholder: '不分类',
    },
  ];
}

/** The greeting, which both forms have. */
const greetingFields: FieldSpec<EditKey>[] = [
  {
    kind: 'select',
    name: 'replyType',
    label: '扫码后回复',
    span: 12,
    options: statusOptions(REPLY_TYPE),
    placeholder: '不额外回复',
  },
  ...replyBodyFields<EditKey>('replyPayload'),
];

/** Label, filing and greeting — everything the code's identity does not depend on. */
function editFields(categoryOptions: SelectOption[]): FieldSpec<EditKey>[] {
  return [...labelFields(categoryOptions), ...greetingFields];
}

/** The same, plus the two fields that can only ever be set once. */
function createFields(categoryOptions: SelectOption[]): FieldSpec<FormKey>[] {
  return [
    ...labelFields(categoryOptions),
    {
      kind: 'text',
      name: 'scene',
      label: '场景值',
      span: 12,
      maxLength: 64,
      help: '留空自动生成。只能用字母、数字、下划线和短横线，生成后不可更改。',
    },
    {
      kind: 'number',
      name: 'expireSeconds',
      label: '有效期',
      span: 12,
      min: 0,
      max: 2_592_000,
      addonAfter: '秒',
      help: '0 表示永久二维码；其他值为临时码，微信最多允许 30 天。',
    },
    ...greetingFields,
  ];
}
