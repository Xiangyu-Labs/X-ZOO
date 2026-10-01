'use client';

import {
  decorDesignate,
  decorDesignations,
  decorDocumentDelete,
  decorDocumentDuplicate,
  decorDocumentList,
  decorDocumentRename,
} from '@shop/contracts/decor/decor.admin.contract';
import { DESIGNATIONS, type Designation } from '@shop/contracts/decor/constants';
import { renameDecorDocumentBody, type DecorDocumentSummary } from '@shop/contracts/decor/schemas';
import { Button, Card, Space, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useState } from 'react';

import { useRouteQuery } from '../api';
import {
  ConfirmButton,
  CrudTable,
  ModalForm,
  PageContainer,
  StatusTag,
  actionsColumn,
  enumColumn,
  instantColumn,
  statusOptions,
  textColumn,
  useDetailHref,
  useFormModal,
} from '../kit';
import { Can } from '../session';
import { CreateDecorDocumentModal } from './create-document';
import { DESIGNATION_LABELS, KIND_LABELS } from './session';

/**
 * 店铺装修 — the page documents.
 *
 * One table for every kind. A page is edited as a draft and published as a
 * numbered revision; 首页 and 个人中心 are *designations* a published page of
 * the matching kind is given here, so a new home page can be prepared and
 * published without touching the live one until it is designated.
 */

const INVALIDATE = [decorDocumentList, decorDesignations];

/** Which designation a kind can take (微页面 none). */
const DESIGNATION_OF_KIND: Partial<Record<DecorDocumentSummary['kind'], Designation>> = {
  home: 'home',
  user_center: 'user_center',
};

const DESIGNATE_LABELS: Record<Designation, string> = {
  home: '设为首页',
  user_center: '设为个人中心',
};

function PublishState({ row }: { row: DecorDocumentSummary }) {
  if (!row.published) return <Tag>未发布</Tag>;
  return (
    <Space size={4}>
      <span>第 {row.published.number} 版</span>
      {row.hasUnpublishedChanges ? (
        <Tag color="orange">有未发布修改</Tag>
      ) : (
        <Tag color="success">已发布</Tag>
      )}
    </Space>
  );
}

function DesignationsCard() {
  const designations = useRouteQuery(decorDesignations);
  const home = designations.data?.home ?? null;
  const userCenter = designations.data?.user_center ?? null;
  const detailHref = useDetailHref();
  const entry = (label: string, row: DecorDocumentSummary | null, empty: string) => (
    <Space size={6} wrap>
      <Typography.Text type="secondary">{label}</Typography.Text>
      {row ? (
        <Link href={detailHref(`/admin/decor/${row.id}`)}>{row.name}</Link>
      ) : (
        <Typography.Text type="warning">{empty}</Typography.Text>
      )}
    </Space>
  );
  return (
    <Card size="small" style={{ marginBottom: 12 }} loading={designations.isPending}>
      <Space size={32} wrap>
        {entry(`${DESIGNATIONS.home}：`, home, '未设置（小程序首页无内容）')}
        <Space size={6}>
          {entry(`${DESIGNATIONS.user_center}：`, userCenter, '内置页面')}
          {userCenter ? (
            <ConfirmButton
              route={decorDesignate}
              input={{ params: { designation: 'user_center' }, body: { documentId: null } }}
              title="恢复为内置个人中心？"
              description="小程序的个人中心会立即改回内置页面；装修过的页面保留，可以再次启用。"
              invalidate={INVALIDATE}
              successMessage="已恢复内置个人中心"
              permission="decor:page:publish"
              buttonProps={{ type: 'link', size: 'small' }}
            >
              恢复内置
            </ConfirmButton>
          ) : null}
        </Space>
      </Space>
    </Card>
  );
}

export function DecorDocumentList() {
  const [creating, setCreating] = useState(false);
  const rename = useFormModal<DecorDocumentSummary>();
  // 返回列表 in the editor comes back to these filters and this page.
  const detailHref = useDetailHref();
  const designations = useRouteQuery(decorDesignations);

  const designateAction = (row: DecorDocumentSummary) => {
    const target = DESIGNATION_OF_KIND[row.kind];
    if (!target) return null;
    const current = designations.data?.[target] ?? null;
    const reason =
      row.designation === target ? '已在使用中' : row.published ? undefined : '请先发布页面';
    return (
      <ConfirmButton
        route={decorDesignate}
        input={{ params: { designation: target }, body: { documentId: row.id } }}
        title={`将「${row.name}」${DESIGNATE_LABELS[target]}？`}
        description={
          <>
            线上第 {row.published?.number ?? '—'} 版立即在小程序
            {target === 'home' ? '首页' : '个人中心'}生效
            {current ? `，原来的「${current.name}」不再使用` : ''}。
            {row.hasUnpublishedChanges ? ' 未发布的修改不会生效。' : ''}
          </>
        }
        invalidate={INVALIDATE}
        successMessage="已启用"
        permission="decor:page:publish"
        buttonProps={{
          type: 'link',
          size: 'small',
          disabled: reason !== undefined,
          ...(reason ? { title: reason } : {}),
        }}
      >
        {DESIGNATE_LABELS[target]}
      </ConfirmButton>
    );
  };

  return (
    <PageContainer title="店铺装修" subTitle="小程序的首页、个人中心与微页面">
      <DesignationsCard />
      <CrudTable
        route={decorDocumentList}
        toolbar={
          <Can permission="decor:page:write">
            <Button type="primary" onClick={() => setCreating(true)}>
              新建页面
            </Button>
          </Can>
        }
        filters={[
          { kind: 'text', name: 'keyword', label: '名称' },
          { kind: 'select', name: 'kind', label: '类型', options: statusOptions(KIND_LABELS) },
        ]}
        columns={[
          {
            ...textColumn<DecorDocumentSummary>({ title: '名称', dataIndex: 'name' }),
            render: (_value: unknown, row: DecorDocumentSummary) => (
              <Space size={4} wrap>
                <Link href={detailHref(`/admin/decor/${row.id}`)}>{row.name}</Link>
                {row.designation ? (
                  <StatusTag value={row.designation} map={DESIGNATION_LABELS} />
                ) : null}
              </Space>
            ),
          },
          enumColumn<DecorDocumentSummary, DecorDocumentSummary['kind']>({
            title: '类型',
            dataIndex: 'kind',
            map: KIND_LABELS,
          }),
          {
            title: '线上版本',
            key: 'published',
            width: 200,
            render: (_value: unknown, row: DecorDocumentSummary) => <PublishState row={row} />,
          },
          instantColumn<DecorDocumentSummary>({ title: '更新时间', dataIndex: 'updatedAt' }),
          actionsColumn<DecorDocumentSummary>({
            width: 300,
            render: (row) => (
              <>
                <Link href={detailHref(`/admin/decor/${row.id}`)}>
                  <Button type="link" size="small">
                    装修
                  </Button>
                </Link>
                <Can permission="decor:page:write">
                  <Button type="link" size="small" onClick={() => rename.show(row)}>
                    重命名
                  </Button>
                </Can>
                <ConfirmButton
                  route={decorDocumentDuplicate}
                  input={{ params: { id: row.id }, body: {} }}
                  title="复制这个页面？"
                  description="复制当前草稿为一个新的未发布页面。"
                  invalidate={INVALIDATE}
                  successMessage="已复制"
                  permission="decor:page:write"
                  buttonProps={{ type: 'link', size: 'small' }}
                >
                  复制
                </ConfirmButton>
                {designateAction(row)}
                <ConfirmButton
                  route={decorDocumentDelete}
                  input={{ params: { id: row.id } }}
                  title={`删除「${row.name}」？`}
                  description="草稿和全部发布记录一并删除，且无法恢复。"
                  invalidate={INVALIDATE}
                  successMessage="已删除"
                  permission="decor:page:write"
                  buttonProps={{
                    type: 'link',
                    size: 'small',
                    danger: true,
                    disabled: row.designation !== null,
                    ...(row.designation ? { title: '使用中的页面不能删除' } : {}),
                  }}
                >
                  删除
                </ConfirmButton>
              </>
            ),
          }),
        ]}
      />

      <ModalForm
        {...rename.props}
        title="重命名"
        schema={renameDecorDocumentBody}
        fields={[{ kind: 'text', name: 'name', label: '页面名称', placeholder: '仅后台可见' }]}
        initialValues={{ name: rename.record?.name ?? '' }}
        route={decorDocumentRename}
        toInput={(values) => ({ params: { id: rename.record?.id ?? '' }, body: values })}
        invalidate={INVALIDATE}
        successMessage="已重命名"
      />
      <CreateDecorDocumentModal open={creating} onClose={() => setCreating(false)} />
    </PageContainer>
  );
}
