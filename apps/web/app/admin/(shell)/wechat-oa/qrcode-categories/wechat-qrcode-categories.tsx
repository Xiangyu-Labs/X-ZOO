'use client';

import { Button, Tooltip, Typography } from 'antd';
import {
  wechatOaQrcodeCategoryCreate,
  wechatOaQrcodeCategoryDelete,
  wechatOaQrcodeCategoryList,
  wechatOaQrcodeCategoryUpdate,
  wechatOaQrcodeList,
} from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import {
  wechatQrcodeCategoryForm,
  type WechatQrcodeCategory,
} from '@shop/contracts/wechat-oa/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { actionsColumn, idColumn, instantColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

/**
 * 渠道码分类 — how an operator files a few hundred posters.
 *
 * Deliberately the plainest screen in the domain: a category is a label and an
 * order, and the only rule worth a sentence is that a category still holding
 * codes cannot be deleted (`WECHAT_OA_CATEGORY_NOT_EMPTY`) — the button is
 * disabled rather than the error explained after the fact.
 */
export function WechatQrcodeCategoriesPage() {
  const modal = useFormModal<WechatQrcodeCategory>();

  return (
    <PageContainer subTitle="给渠道二维码分组，方便按门店、活动或投放渠道查看">
      <CrudTable
        route={wechatOaQrcodeCategoryList}
        toolbar={
          <Can permission="wechat-oa:qrcode:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建分类
            </Button>
          </Can>
        }
        columns={[
          idColumn<WechatQrcodeCategory>(),
          textColumn<WechatQrcodeCategory>({ title: '名称', dataIndex: 'name', ellipsis: true }),
          {
            title: '渠道码数量',
            key: 'qrcodeCount',
            width: 120,
            render: (_value: unknown, row: WechatQrcodeCategory) => (
              <Typography.Text>{row.qrcodeCount}</Typography.Text>
            ),
          },
          {
            title: '排序',
            key: 'sortOrder',
            width: 90,
            render: (_value: unknown, row: WechatQrcodeCategory) => row.sortOrder,
          },
          instantColumn<WechatQrcodeCategory>({ title: '创建时间', dataIndex: 'createdAt' }),
          actionsColumn<WechatQrcodeCategory>({
            width: 150,
            render: (row) => (
              <>
                <Can permission="wechat-oa:qrcode:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                </Can>
                <Tooltip title={row.qrcodeCount > 0 ? '分类下还有渠道码，先移走或删除它们' : ''}>
                  <span>
                    <ConfirmButton
                      route={wechatOaQrcodeCategoryDelete}
                      input={{ params: { id: row.id } }}
                      title={`删除分类「${row.name}」？`}
                      invalidate={[wechatOaQrcodeCategoryList, wechatOaQrcodeList]}
                      successMessage="已删除"
                      permission="wechat-oa:qrcode:write"
                      buttonProps={{
                        type: 'link',
                        size: 'small',
                        danger: true,
                        disabled: row.qrcodeCount > 0,
                      }}
                    >
                      删除
                    </ConfirmButton>
                  </span>
                </Tooltip>
              </>
            ),
          }),
        ]}
      />

      <ModalForm
        {...modal.props}
        title={modal.record ? `编辑：${modal.record.name}` : '新建分类'}
        schema={wechatQrcodeCategoryForm}
        fields={[
          { kind: 'text', name: 'name', label: '名称', maxLength: 64 },
          {
            kind: 'number',
            name: 'sortOrder',
            label: '排序',
            min: 0,
            max: 9999,
            help: '数字小的排在前面。',
          },
        ]}
        initialValues={
          modal.record ? { name: modal.record.name, sortOrder: modal.record.sortOrder } : undefined
        }
        route={modal.record ? wechatOaQrcodeCategoryUpdate : wechatOaQrcodeCategoryCreate}
        toInput={(values) =>
          modal.record ? { params: { id: modal.record.id }, body: values } : { body: values }
        }
        invalidate={[wechatOaQrcodeCategoryList, wechatOaQrcodeList]}
        successMessage="已保存"
      />
    </PageContainer>
  );
}
