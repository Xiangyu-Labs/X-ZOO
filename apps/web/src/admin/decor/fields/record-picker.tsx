'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Avatar,
  Button,
  Empty,
  Input,
  List,
  Modal,
  Pagination,
  Spin,
  TreeSelect,
  Typography,
} from 'antd';
import { useState } from 'react';

import { useOptionalSession } from '../../session/session-provider';
import {
  RECORD_KIND_LABELS,
  useDecorRecordSource,
  type DecorRecord,
  type DecorRecordKind,
  type DecorTreeNode,
} from '../records';

const RECORD_READ_PERMISSION: Record<DecorRecordKind, string> = {
  product: 'catalog:product:read',
  label: 'catalog:label:read',
  article: 'cms:article:read',
  coupon: 'coupon:template:read',
  groupbuy: 'groupbuy:activity:read',
  presale: 'presale:activity:read',
  page: 'decor:page:read',
};

const CATEGORY_READ_PERMISSION: Record<'product' | 'article', string> = {
  product: 'catalog:category:read',
  article: 'cms:article:read',
};

const PAGE_SIZE = 10;

export interface RecordPickerModalProps {
  kind: DecorRecordKind;
  open: boolean;
  onClose: () => void;
  onPick: (record: DecorRecord) => void;
  /** Already picked: shown as 已选 and not offered again. */
  chosen: readonly string[];
}

/** A searchable, paged list of one kind of record. Stays open for a multi-pick. */
export function RecordPickerModal({ kind, open, onClose, onPick, chosen }: RecordPickerModalProps) {
  const source = useDecorRecordSource();
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const label = RECORD_KIND_LABELS[kind];
  const list = useQuery({
    queryKey: ['decor.picker', kind, keyword, page],
    queryFn: () => source.list(kind, { keyword, page, pageSize: PAGE_SIZE }),
    enabled: open,
  });
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={`选择${label}`}
      width={560}
      destroyOnHidden
    >
      <Input.Search
        allowClear
        placeholder={`搜索${label}名称`}
        onSearch={(next) => {
          setKeyword(next.trim());
          setPage(1);
        }}
        style={{ marginBottom: 12 }}
      />
      <Spin spinning={list.isFetching}>
        {list.isError ? (
          <Typography.Text type="danger">加载失败，请稍后重试</Typography.Text>
        ) : (
          <List
            size="small"
            locale={{ emptyText: <Empty description={`没有可选的${label}`} /> }}
            dataSource={list.data?.items ?? []}
            renderItem={(item) => {
              const picked = chosen.includes(item.id);
              return (
                <List.Item
                  actions={[
                    <Button
                      key="pick"
                      size="small"
                      type="link"
                      disabled={picked}
                      onClick={() => onPick(item)}
                    >
                      {picked ? '已选' : '选择'}
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    {...(item.image
                      ? { avatar: <Avatar shape="square" size={36} src={item.image} /> }
                      : {})}
                    title={item.name}
                    description={item.subtitle}
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Spin>
      <Pagination
        style={{ marginTop: 12, textAlign: 'right' }}
        size="small"
        current={page}
        pageSize={PAGE_SIZE}
        total={list.data?.total ?? 0}
        onChange={setPage}
        showSizeChanger={false}
      />
    </Modal>
  );
}

/** Stored ids back into rows, in order; `missing` counts ids whose record is gone. */
export function useResolvedRecords(kind: DecorRecordKind, ids: readonly string[]) {
  const source = useDecorRecordSource();
  const session = useOptionalSession();
  const readable = session === null || session.can(RECORD_READ_PERMISSION[kind]);
  const query = useQuery({
    queryKey: ['decor.resolve', kind, ids],
    queryFn: () => source.resolve(kind, ids),
    enabled: readable && ids.length > 0,
    staleTime: 60_000,
    meta: { presentError: false },
  });
  const byId = new Map((query.data ?? []).map((row) => [row.id, row]));
  return {
    rows: ids.map((id) => byId.get(id)),
    readable,
    isPending: readable && ids.length > 0 && query.isPending,
    isError: readable && query.isError,
  };
}

/** One picked record with a 选择/更换 button. */
export function SingleRecordPicker({
  kind,
  value,
  onChange,
  readOnly = false,
}: {
  kind: DecorRecordKind;
  value: string | undefined;
  onChange: (id: string) => void;
  readOnly?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const ids = value ? [value] : [];
  const { rows, readable, isPending, isError } = useResolvedRecords(kind, ids);
  const row = rows[0];
  let text = <Typography.Text type="secondary">未选择</Typography.Text>;
  if (value) {
    if (!readable) text = <Typography.Text type="secondary">#{value}</Typography.Text>;
    else if (isPending) text = <Typography.Text type="secondary">加载中…</Typography.Text>;
    else if (row) text = <Typography.Text ellipsis>{row.name}</Typography.Text>;
    else if (isError) text = <Typography.Text type="danger">#{value}（加载失败）</Typography.Text>;
    else text = <Typography.Text type="warning">#{value}（已不存在）</Typography.Text>;
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>{text}</div>
      <Button size="small" disabled={readOnly} onClick={() => setOpen(true)}>
        {value ? '更换' : `选择${RECORD_KIND_LABELS[kind]}`}
      </Button>
      <RecordPickerModal
        kind={kind}
        open={open}
        chosen={ids}
        onClose={() => setOpen(false)}
        onPick={(record) => {
          onChange(record.id);
          setOpen(false);
        }}
      />
    </div>
  );
}

interface TreeOption {
  value: string;
  title: string;
  children?: TreeOption[];
}

function toTreeData(nodes: readonly DecorTreeNode[]): TreeOption[] {
  return nodes.map((node) => ({
    value: node.id,
    title: node.name,
    ...(node.children?.length ? { children: toTreeData(node.children) } : {}),
  }));
}

export function CategoryTreeSelect({
  tree,
  value,
  onChange,
  allowClear = false,
  placeholder,
  readOnly = false,
}: {
  tree: 'product' | 'article';
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  allowClear?: boolean | undefined;
  placeholder?: string | undefined;
  readOnly?: boolean | undefined;
}) {
  const source = useDecorRecordSource();
  const session = useOptionalSession();
  const readable = session === null || session.can(CATEGORY_READ_PERMISSION[tree]);
  const nodes = useQuery({
    queryKey: ['decor.categories', tree],
    queryFn: () => source.categories(tree),
    enabled: readable,
    staleTime: 60_000,
    meta: { presentError: false },
  });
  const treeData = readable
    ? toTreeData(nodes.data ?? [])
    : value
      ? [{ value, title: `#${value}` }]
      : [];
  return (
    <TreeSelect
      style={{ width: '100%' }}
      size="small"
      {...(value ? { value } : {})}
      placeholder={placeholder ?? (tree === 'product' ? '选择商品分类' : '选择资讯分类')}
      disabled={readOnly}
      allowClear={allowClear}
      loading={readable && nodes.isPending}
      treeData={treeData}
      treeDefaultExpandAll
      showSearch
      treeNodeFilterProp="title"
      onChange={(next: string | undefined) => onChange(next || undefined)}
    />
  );
}
