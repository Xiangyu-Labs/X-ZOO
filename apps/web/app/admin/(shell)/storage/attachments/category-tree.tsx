'use client';

import { Button, Card, Empty, Popconfirm, Space, Spin, Typography, message } from 'antd';
import { useMemo, useState } from 'react';
import {
  storageCategoryCreate,
  storageCategoryDelete,
  storageCategoryTree,
  storageCategoryUpdate,
} from '@shop/contracts/storage/storage.admin.contract';
import {
  attachmentCategoryForm,
  type AttachmentCategoryNode,
} from '@shop/contracts/storage/schemas';

import { useRouteMutation, useRouteQuery } from '@/admin/api/hooks';
import { ModalForm } from '@/admin/kit/form/modal-form';
import { SideTree } from '@/admin/kit/tree/side-tree';
import { Can } from '@/admin/session/can';

interface TreeNode {
  key: string;
  title: string;
  children: TreeNode[];
}

/**
 * The folder column of the media library.
 *
 * Folders are a browsing aid, not a permission boundary: a file's category can
 * change, and moving a folder re-parents its whole subtree (a materialised
 * `path`, rewritten in one statement). Deleting is refused while the folder
 * still holds files or subfolders — the guard lives in the DELETE, so a file
 * uploaded a millisecond ago still blocks it.
 */
export function CategoryTree({
  selectedId,
  onSelect,
}: {
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  const [editing, setEditing] = useState<AttachmentCategoryNode | null>(null);
  const [creating, setCreating] = useState(false);
  const { data, isPending } = useRouteQuery(storageCategoryTree);

  const items = useMemo(() => data?.items ?? [], [data]);
  const tree = useMemo(() => nest(items), [items]);
  const selected = items.find((item) => item.id === selectedId);

  const remove = useRouteMutation(storageCategoryDelete, {
    invalidate: [storageCategoryTree],
    onSuccess: () => {
      void message.success('已删除分类');
      onSelect(undefined);
    },
  });

  const parentOptions = [
    { value: '', label: '顶级分类' },
    ...items.map((item) => ({
      value: item.id,
      label: `${'　'.repeat(item.depth)}${item.name}`,
    })),
  ];

  return (
    <Card
      size="small"
      title="分类"
      styles={{ body: { padding: 8 } }}
      extra={
        <Can permission="storage:category:write">
          <Button type="link" size="small" onClick={() => setCreating(true)}>
            新建
          </Button>
        </Can>
      }
    >
      {isPending ? (
        <Spin />
      ) : tree.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有分类" />
      ) : (
        <SideTree
          treeData={[{ key: '', title: '全部素材', children: tree }]}
          defaultExpandAll
          selectedKeys={[selectedId ?? '']}
          onSelect={(keys) => {
            const key = String(keys[0] ?? '');
            onSelect(key === '' ? undefined : key);
          }}
        />
      )}

      {selected && (
        <Space style={{ padding: '8px 4px 0' }} size="small" wrap>
          <Typography.Text type="secondary" style={{ wordBreak: 'break-all' }}>
            {selected.name}
          </Typography.Text>
          <Can permission="storage:category:write">
            <Button type="link" size="small" onClick={() => setEditing(selected)}>
              重命名
            </Button>
          </Can>
          <Can permission="storage:category:delete">
            <Popconfirm
              title={`删除分类「${selected.name}」？`}
              description="分类里还有素材或子分类时不能删除。"
              okText="删除"
              okButtonProps={{ danger: true, loading: remove.isPending }}
              onConfirm={() => remove.mutate({ params: { id: selected.id } })}
            >
              <Button type="link" size="small" danger loading={remove.isPending}>
                删除
              </Button>
            </Popconfirm>
          </Can>
        </Space>
      )}

      <ModalForm
        open={creating || editing !== null}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        key={editing?.id ?? 'new'}
        title={editing ? `编辑分类：${editing.name}` : '新建分类'}
        size="small"
        schema={attachmentCategoryForm}
        fields={[
          { kind: 'text', name: 'name', label: '名称', span: 24 },
          {
            kind: 'select',
            name: 'parentId',
            label: '上级分类',
            options: parentOptions.filter((option) => option.value !== editing?.id),
            span: 24,
            help: '移动分类会连同其下的子分类一起移动',
          },
          { kind: 'number', name: 'sortOrder', label: '排序', min: 0, span: 24 },
        ]}
        initialValues={
          editing
            ? {
                name: editing.name,
                ...(editing.parentId === null ? {} : { parentId: editing.parentId }),
                sortOrder: editing.sortOrder,
              }
            : { sortOrder: 0, ...(selectedId ? { parentId: selectedId } : {}) }
        }
        route={editing ? storageCategoryUpdate : storageCategoryCreate}
        toInput={(values) => {
          // The select uses `''` for 顶级分类; the contract wants null.
          const body = { ...values, parentId: values.parentId ? values.parentId : null };
          return editing ? { params: { id: editing.id }, body } : { body };
        }}
        invalidate={[storageCategoryTree]}
        successMessage="已保存"
      />
    </Card>
  );
}

/** Flat, depth-first list → nested tree. Every parent precedes its children. */
function nest(items: readonly AttachmentCategoryNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const item of items) {
    const node: TreeNode = { key: item.id, title: item.name, children: [] };
    byId.set(item.id, node);
    const parent = item.parentId === null ? undefined : byId.get(item.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
