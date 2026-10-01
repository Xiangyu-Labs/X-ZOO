'use client';

import { Alert, Button, Card, Space, Tabs, Typography } from 'antd';
import { useState } from 'react';

import { useRouteQuery } from '@/admin/api/hooks';
import { AssetPicker } from '@/admin/kit/asset/asset-picker';
import { AssetSourceProvider } from '@/admin/kit/asset/asset-source-context';
import type { AssetItem } from '@/admin/kit/asset/types';
import { ConfigGroupForm } from '@/admin/kit/config/config-group-form';
import type { ConfigGroupDescriptor } from '@/admin/kit/config/types';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { DescriptionsCard } from '@/admin/kit/descriptions-card';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { ZodForm } from '@/admin/kit/form/zod-form';
import { InstantText } from '@/admin/kit/instant-text';
import { LinkPicker, LinkSourceProvider } from '@/admin/kit/link/link-picker';
import type { LinkValue } from '@/admin/kit/link/types';
import { MoneyText } from '@/admin/kit/money-text';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  enumColumn,
  idColumn,
  imageColumn,
  instantColumn,
  moneyColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';
import {
  demoConfigGet,
  demoConfigSave,
  demoWidgetCreate,
  demoWidgetDelete,
  demoWidgetForm,
  demoWidgetList,
  demoWidgetUpdate,
  type DemoWidget,
} from './demo-contract';
import { createDemoAssetSource } from './demo-asset-source';
import { DEMO_STATUS, demoFields } from './demo-fields';
import { createDemoLinkSource } from './demo-link-source';
import { installDemoFetch } from './mock-fetch';

installDemoFetch();

const demoLinks = createDemoLinkSource();
const demoAssets = createDemoAssetSource();

const CONFIG_GROUP: ConfigGroupDescriptor = {
  group: 'demo',
  title: '演示配置组',
  description:
    '这一页由描述符渲染；真实配置页只需要提供描述符和取值/保存两个路由。带 section 的字段会按首次出现顺序分节显示。',
  fields: [
    { key: 'siteName', label: '站点名称', kind: 'text', required: true, span: 12 },
    { key: 'contactPhone', label: '客服电话', kind: 'text', span: 12 },
    {
      key: 'apiSecret',
      label: '接口密钥',
      kind: 'password',
      span: 12,
      section: '密钥',
      help: '演示：已设置的密钥不会回传到浏览器',
    },
    { key: 'smsSecret', label: '短信密钥', kind: 'password', span: 12, section: '密钥' },
    {
      key: 'deliveryMode',
      label: '配送方式',
      kind: 'select',
      span: 12,
      section: '交易',
      options: [
        { label: '快递', value: 'express' },
        { label: '同城', value: 'city' },
      ],
    },
    {
      key: 'freeShippingOver',
      label: '包邮门槛',
      kind: 'money',
      span: 12,
      section: '交易',
      visibleWhen: { key: 'deliveryMode', equals: 'express' },
    },
    { key: 'enableInvoice', label: '开启发票', kind: 'switch', span: 12, section: '交易' },
    { key: 'maxPerOrder', label: '每单上限', kind: 'number', min: 1, span: 12, section: '交易' },
    { key: 'logo', label: '站点 LOGO', kind: 'asset', span: 12, section: '外观' },
    { key: 'extra', label: '额外参数', kind: 'json', span: 24, section: '外观' },
  ],
};

/**
 * Live reference for everything in `src/admin/kit/`, served from
 * `/admin/dev/kit` and kept out of the production menu (`devOnly`).
 *
 * It runs against real `defineRoute` contracts answered by an in-memory
 * fetch — no handler, no database — so it needs nothing but the admin shell,
 * and breaks loudly if a kit component stops honouring the contract shapes.
 * `<LinkPicker>` and `<AssetPicker>` read the in-memory
 * `createDemoLinkSource()` and `createDemoAssetSource()` the same way.
 */
export function KitDemo() {
  const modal = useFormModal<DemoWidget>();
  const [assetOpen, setAssetOpen] = useState(false);
  const [picked, setPicked] = useState<AssetItem[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState<LinkValue | null>(null);

  const config = useRouteQuery(demoConfigGet, { params: { group: 'demo' } });

  return (
    <AssetSourceProvider source={demoAssets}>
      <LinkSourceProvider source={demoLinks}>
        <PageContainer
          title="组件套件演示"
          subTitle="每个 kit 组件的可运行示例；数据来自内存中的假接口"
          extra={
            <Typography.Text type="secondary">源码：app/admin/(shell)/dev/kit/</Typography.Text>
          }
        >
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="仅开发环境可见"
            description="本页只在 NODE_ENV !== 'production' 时出现在菜单里，使用的是 /admin-api/dev-demo/* 假路由。"
          />

          <Tabs
            defaultActiveKey="table"
            items={[
              {
                key: 'table',
                label: 'CrudTable',
                children: (
                  <>
                    <CrudTable
                      route={demoWidgetList}
                      rowKey="id"
                      scrollX={900}
                      filters={[
                        { kind: 'text', name: 'keyword', label: '名称' },
                        {
                          kind: 'select',
                          name: 'status',
                          label: '状态',
                          multiple: true,
                          options: [
                            { label: '草稿', value: 'draft' },
                            { label: '已启用', value: 'active' },
                            { label: '已暂停', value: 'paused' },
                            { label: '已归档', value: 'archived' },
                          ],
                        },
                        { kind: 'number', name: 'minQuantity', label: '最少库存' },
                        {
                          kind: 'dateRange',
                          names: ['createdFrom', 'createdTo'],
                          label: '创建时间',
                        },
                      ]}
                      toolbar={
                        <Can permission="dev:demo:create">
                          <Button type="primary" onClick={() => modal.show()}>
                            新建
                          </Button>
                        </Can>
                      }
                      batchActions={({ selectedRows, clear }) => (
                        <Button
                          size="small"
                          danger
                          onClick={() => {
                            window.alert(`演示：批量操作 ${selectedRows.length} 项`);
                            clear();
                          }}
                        >
                          批量归档
                        </Button>
                      )}
                      columns={[
                        idColumn<DemoWidget>({ sortable: true }),
                        imageColumn<DemoWidget>({ title: '图片', dataIndex: 'image' }),
                        textColumn<DemoWidget>({
                          title: '名称',
                          dataIndex: 'name',
                          ellipsis: true,
                          sortable: true,
                        }),
                        moneyColumn<DemoWidget>({
                          title: '价格',
                          dataIndex: 'price',
                          sortable: true,
                        }),
                        textColumn<DemoWidget>({
                          title: '库存',
                          dataIndex: 'quantity',
                          align: 'right',
                          sortable: true,
                        }),
                        enumColumn<DemoWidget, DemoWidget['status']>({
                          title: '状态',
                          dataIndex: 'status',
                          map: DEMO_STATUS,
                        }),
                        instantColumn<DemoWidget>({
                          title: '创建时间',
                          dataIndex: 'createdAt',
                          sortable: true,
                        }),
                        actionsColumn<DemoWidget>({
                          render: (row) => (
                            <>
                              <Button type="link" size="small" onClick={() => modal.show(row)}>
                                编辑
                              </Button>
                              <ConfirmButton
                                route={demoWidgetDelete}
                                input={{ params: { id: row.id } }}
                                title="确认删除该组件？"
                                invalidate={[demoWidgetList]}
                                successMessage="已删除"
                                permission="dev:demo:delete"
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
                      title={modal.record ? `编辑：${modal.record.name}` : '新建组件'}
                      size="large"
                      columns={2}
                      schema={demoWidgetForm}
                      fields={demoFields}
                      initialValues={
                        modal.record
                          ? {
                              name: modal.record.name,
                              price: modal.record.price,
                              quantity: modal.record.quantity,
                              status: modal.record.status,
                              ...(modal.record.image ? { image: modal.record.image } : {}),
                            }
                          : undefined
                      }
                      route={modal.record ? demoWidgetUpdate : demoWidgetCreate}
                      toInput={(values) =>
                        modal.record
                          ? { params: { id: modal.record.id }, body: values }
                          : { body: values }
                      }
                      invalidate={[demoWidgetList]}
                      successMessage="已保存"
                    />
                  </>
                ),
              },

              {
                key: 'form',
                label: 'ZodForm',
                children: (
                  <Card size="small" title="所有字段类型">
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 16 }}
                      message="把名称填成 422 再提交，可以看到服务端 422 被映射回字段"
                    />
                    <ZodForm
                      schema={demoWidgetForm}
                      columns={2}
                      fields={demoFields}
                      initialValues={{ name: '示例组件', price: '99.00', quantity: 3 }}
                      onSubmit={(values) => window.alert(JSON.stringify(values, null, 2))}
                      submitText="提交（弹出解析后的值）"
                    />
                  </Card>
                ),
              },

              {
                key: 'pickers',
                label: 'AssetPicker / LinkPicker',
                children: (
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    <Card size="small" title="AssetPicker">
                      <Space wrap>
                        <Button onClick={() => setAssetOpen(true)}>打开素材库（多选）</Button>
                        <Typography.Text type="secondary">已选 {picked.length} 个</Typography.Text>
                      </Space>
                      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                        {picked.map((asset) => (
                          <img
                            key={asset.id}
                            src={asset.url}
                            alt={asset.name}
                            style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 4 }}
                          />
                        ))}
                      </div>
                      <AssetPicker
                        open={assetOpen}
                        multiple
                        max={6}
                        onClose={() => setAssetOpen(false)}
                        onSelect={setPicked}
                      />
                    </Card>

                    <Card size="small" title="LinkPicker">
                      <Space wrap>
                        <Button onClick={() => setLinkOpen(true)}>选择链接</Button>
                        <Typography.Text code>
                          {link ? JSON.stringify(link) : '未选择'}
                        </Typography.Text>
                      </Space>
                      <LinkPicker
                        open={linkOpen}
                        onClose={() => setLinkOpen(false)}
                        onSelect={setLink}
                        {...(link ? { value: link } : {})}
                      />
                    </Card>
                  </Space>
                ),
              },

              {
                key: 'config',
                label: 'ConfigGroupForm',
                children: (
                  <ConfigGroupForm
                    descriptor={CONFIG_GROUP}
                    values={config.data?.values}
                    loading={config.isPending}
                    columns={2}
                    route={demoConfigSave}
                    invalidate={[demoConfigGet]}
                    successMessage="已保存"
                  />
                ),
              },

              {
                key: 'primitives',
                label: '展示组件',
                children: (
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    <DescriptionsCard
                      title="DescriptionsCard / MoneyText / InstantText / StatusTag"
                      items={[
                        { label: '金额', value: <MoneyText value="123456.70" /> },
                        { label: '负数金额', value: <MoneyText value="-12.00" colored /> },
                        { label: '时间', value: <InstantText value="2026-03-01T10:00:00+08:00" /> },
                        {
                          label: '相对时间',
                          value: (
                            <InstantText value="2026-03-01T10:00:00+08:00" format="relative" />
                          ),
                        },
                        { label: '状态', value: <StatusTag value="active" map={DEMO_STATUS} /> },
                        { label: '空值', value: null },
                      ]}
                    />

                    <Card size="small" title="Can / 权限">
                      <Space direction="vertical">
                        <Can
                          permission="dev:demo:create"
                          fallback={<span>（无 dev:demo:create 权限时的替代内容）</span>}
                        >
                          <Button>只有拥有 dev:demo:create 才能看到</Button>
                        </Can>
                        <Can
                          permission="never:granted:atom"
                          fallback={<span>没有 never:granted:atom 权限，已隐藏</span>}
                        >
                          <Button danger>不该出现</Button>
                        </Can>
                      </Space>
                    </Card>
                  </Space>
                ),
              },
            ]}
          />
        </PageContainer>
      </LinkSourceProvider>
    </AssetSourceProvider>
  );
}
