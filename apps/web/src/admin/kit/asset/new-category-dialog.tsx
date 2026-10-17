'use client';

import { App, Form, Input, Modal, TreeSelect } from 'antd';
import { useState } from 'react';

import { ApiError } from '../../api/errors';
import type { AssetCategory } from './types';

interface Values {
  name?: string | undefined;
  parentId?: string | undefined;
}

interface ParentOption {
  value: string;
  title: string;
  children?: ParentOption[];
}

function toTreeSelect(list: readonly AssetCategory[]): ParentOption[] {
  return list.map((category) => ({
    value: category.id,
    title: category.name,
    ...(category.children?.length ? { children: toTreeSelect(category.children) } : {}),
  }));
}

/**
 * 新建分类 from inside the picker, so an operator filing a product's pictures
 * does not have to leave the form for 素材管理. The new folder goes under the
 * one being browsed unless they choose otherwise.
 */
export function NewCategoryDialog({
  open,
  categories,
  defaultParentId,
  onClose,
  onCreate,
}: {
  open: boolean;
  categories: readonly AssetCategory[];
  defaultParentId?: string | undefined;
  onClose: () => void;
  onCreate: (input: { name: string; parentId?: string | undefined }) => Promise<void>;
}) {
  const [form] = Form.useForm<Values>();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();

  const submit = async (): Promise<void> => {
    let values: Values;
    try {
      values = await form.validateFields();
    } catch {
      return; // The form shows what is missing.
    }
    setSaving(true);
    try {
      await onCreate({ name: (values.name ?? '').trim(), parentId: values.parentId });
      void message.success(`已新建分类「${(values.name ?? '').trim()}」`);
      onClose();
    } catch (error) {
      // A server refusal (too deep, parent gone) is written for the operator; anything else is not.
      void message.error(ApiError.is(error) ? error.message : '新建分类失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新建分类"
      okText="确定"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      {/* Mounted afresh each time it opens, so it starts from the folder being browsed. */}
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ parentId: defaultParentId }}
      >
        <Form.Item
          name="name"
          label="分类名称"
          rules={[
            { required: true, whitespace: true, message: '请填写分类名称' },
            { max: 64, message: '分类名称最多 64 个字' },
          ]}
        >
          <Input placeholder="例如：主图、详情图" maxLength={64} autoFocus />
        </Form.Item>
        <Form.Item name="parentId" label="上级分类" help="不选则为顶级分类">
          <TreeSelect
            allowClear
            treeDefaultExpandAll
            placeholder="顶级分类"
            treeData={toTreeSelect(categories)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
