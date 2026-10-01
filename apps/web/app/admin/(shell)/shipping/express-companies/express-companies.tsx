'use client';

import { Button, Switch } from 'antd';
import {
  expressCompanyAdminList,
  expressCompanyCreate,
  expressCompanyDelete,
  expressCompanySetStatus,
  expressCompanyUpdate,
} from '@shop/contracts/shipping/shipping.express.contract';
import { expressCompanyForm, type ExpressCompanyRow } from '@shop/contracts/shipping/schemas';

import { useRouteMutation } from '@/admin/api/hooks';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { PageContainer } from '@/admin/kit/page-container';
import { actionsColumn, idColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

/**
 * 快递公司.
 *
 * The common carriers arrive seeded, so the usual operations are 启用/停用 and
 * reordering; a rarer carrier is added with 新建. The 发货 picker shows enabled
 * rows, most used first, and that is the only thing `sortOrder` does.
 *
 * Deleting is deliberately awkward (a confirm, and the server refuses while a
 * shipment points at the row). 停用 is the way to retire a carrier.
 */
export function ExpressCompaniesPage() {
  const modal = useFormModal<ExpressCompanyRow>();

  const setStatus = useRouteMutation(expressCompanySetStatus, {
    invalidate: [expressCompanyAdminList],
    successMessage: '已更新状态',
  });

  return (
    <PageContainer subTitle="发货时可选的快递公司；停用后发货页不再显示，历史运单不受影响">
      <CrudTable
        route={expressCompanyAdminList}
        filters={[
          { kind: 'text', name: 'keyword', label: '关键词', placeholder: '名称或编码' },
          {
            kind: 'select',
            name: 'isEnabled',
            label: '状态',
            options: [
              { value: 'true', label: '启用' },
              { value: 'false', label: '停用' },
            ],
          },
        ]}
        toolbar={
          <Can permission="shipping:express:write">
            <Button type="primary" onClick={() => modal.show()}>
              新建
            </Button>
          </Can>
        }
        columns={[
          idColumn<ExpressCompanyRow>({ sortable: true }),
          textColumn<ExpressCompanyRow>({ title: '名称', dataIndex: 'name', sortable: true }),
          textColumn<ExpressCompanyRow>({ title: '编码', dataIndex: 'code' }),
          textColumn<ExpressCompanyRow>({ title: '微信快递编码', dataIndex: 'wechatDeliveryId' }),
          {
            title: '排序',
            dataIndex: 'sortOrder',
            key: 'sortOrder',
            width: 100,
            sorter: true,
          },
          {
            title: '启用',
            key: 'isEnabled',
            width: 100,
            render: (_value: unknown, row: ExpressCompanyRow) => (
              <Can permission="shipping:express:write" fallback={row.isEnabled ? '启用' : '停用'}>
                <Switch
                  size="small"
                  checked={row.isEnabled}
                  loading={setStatus.isPending && setStatus.variables?.params?.id === row.id}
                  onChange={(checked) =>
                    setStatus.mutate({ params: { id: row.id }, body: { isEnabled: checked } })
                  }
                />
              </Can>
            ),
          },
          actionsColumn<ExpressCompanyRow>({
            render: (row) => (
              <>
                <Can permission="shipping:express:write">
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                </Can>
                <ConfirmButton
                  route={expressCompanyDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除快递公司「${row.name}」？`}
                  description="已产生运单的快递公司无法删除，改用停用。"
                  invalidate={[expressCompanyAdminList]}
                  successMessage="已删除"
                  permission="shipping:express:write"
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
        title={modal.record ? '编辑快递公司' : '新建快递公司'}
        schema={expressCompanyForm}
        fields={[
          { kind: 'text', name: 'name', label: '名称', span: 12 },
          {
            kind: 'text',
            name: 'code',
            label: '编码',
            span: 12,
            help: '物流查询用的编码，如 shunfeng、zhongtong；也可填阿里云的编码，如 SFEXPRESS、ZTO',
          },
          {
            kind: 'text',
            name: 'wechatDeliveryId',
            label: '微信快递编码',
            span: 12,
            help: '小程序发货信息管理使用的编码（微信运力列表中的 delivery_id，如 SF），留空表示未设置',
          },
          { kind: 'number', name: 'sortOrder', label: '排序', span: 12, min: 0, max: 9999 },
          { kind: 'switch', name: 'isEnabled', label: '启用', span: 12 },
        ]}
        initialValues={modal.record ?? { sortOrder: 0, isEnabled: true }}
        route={modal.record ? expressCompanyUpdate : expressCompanyCreate}
        toInput={(values) => {
          // An emptied text box means "not set", which the API spells `null`.
          const body = { ...values, wechatDeliveryId: values.wechatDeliveryId || null };
          return modal.record ? { params: { id: modal.record.id }, body } : { body };
        }}
        invalidate={[expressCompanyAdminList]}
        successMessage="已保存"
      />
    </PageContainer>
  );
}
