'use client';

import { Input } from 'antd';

import type { FieldSpec } from '@/admin/kit/form/types';
import type { StatusMap } from '@/admin/kit/status-tag';

import type { DemoWidgetForm } from './demo-contract';

export const DEMO_STATUS: StatusMap<'draft' | 'active' | 'paused' | 'archived'> = {
  draft: { label: '草稿', color: 'default' },
  active: { label: '已启用', color: 'success' },
  paused: { label: '已暂停', color: 'warning' },
  archived: { label: '已归档', color: 'error' },
};

const CATEGORY_TREE = [
  {
    title: '首页组件',
    value: 'home',
    children: [
      { title: '轮播', value: 'home.banner' },
      { title: '金刚区', value: 'home.nav' },
    ],
  },
  { title: '商品组件', value: 'goods' },
];

const AREA_TREE = [
  {
    label: '北京市',
    value: '110000',
    children: [
      { label: '北京市', value: '110100', children: [{ label: '东城区', value: '110101' }] },
    ],
  },
  {
    label: '浙江省',
    value: '330000',
    children: [
      { label: '杭州市', value: '330100', children: [{ label: '西湖区', value: '330106' }] },
    ],
  },
];

/**
 * One field of every kind the kit ships, against the demo contract's body
 * schema. Copy a line out of here when building a real page.
 */
export const demoFields: FieldSpec<Extract<keyof DemoWidgetForm, string>>[] = [
  {
    kind: 'text',
    name: 'name',
    label: '名称',
    placeholder: '输入 422 可触发服务端校验错误',
    span: 12,
  },
  { kind: 'money', name: 'price', label: '价格', span: 6 },
  { kind: 'number', name: 'quantity', label: '库存', min: 0, span: 6 },

  {
    kind: 'select',
    name: 'status',
    label: '状态',
    span: 8,
    options: [
      { label: '草稿', value: 'draft' },
      { label: '已启用', value: 'active' },
      { label: '已暂停', value: 'paused' },
      { label: '已归档', value: 'archived' },
    ],
  },
  {
    kind: 'radio',
    name: 'channel',
    label: '投放端',
    optionType: 'button',
    span: 8,
    options: [
      { label: 'H5', value: 'h5' },
      { label: '小程序', value: 'mini' },
      { label: '公众号', value: 'oa' },
    ],
  },
  {
    kind: 'switch',
    name: 'enabled',
    label: '启用',
    checkedText: '开',
    uncheckedText: '关',
    span: 8,
  },

  {
    kind: 'treeSelect',
    name: 'categoryId',
    label: '分类',
    span: 12,
    treeData: CATEGORY_TREE,
    leafOnly: true,
  },
  {
    kind: 'cascader',
    name: 'area',
    label: '地区',
    span: 12,
    options: AREA_TREE,
  },

  {
    kind: 'checkbox',
    name: 'tags',
    label: '标签',
    span: 24,
    options: [
      { label: '新品', value: 'new' },
      { label: '热卖', value: 'hot' },
      { label: '推荐', value: 'rec' },
    ],
  },

  { kind: 'date', name: 'publishedAt', label: '上架时间', showTime: true, span: 12 },
  { kind: 'dateRange', name: 'window', label: '有效期', span: 12 },

  { kind: 'asset', name: 'image', label: '主图', span: 12 },
  { kind: 'asset', name: 'gallery', label: '图集', multiple: true, max: 5, span: 12 },

  { kind: 'link', name: 'link', label: '跳转链接', span: 24 },

  {
    kind: 'sortableList',
    name: 'slides',
    label: '轮播项（拖动排序）',
    span: 24,
    addText: '添加一张',
    newItem: () => ({ title: '', url: '' }),
    renderItem: (item: never, helpers) => {
      const slide = item as unknown as { title: string; url: string };
      return (
        <Input
          value={slide.title}
          placeholder="标题"
          disabled={helpers.disabled}
          onChange={(event) =>
            helpers.set({ ...slide, title: event.target.value } as unknown as never)
          }
        />
      );
    },
  },

  {
    kind: 'textarea',
    name: 'note',
    label: '备注',
    rows: 3,
    maxLength: 200,
    showCount: true,
    span: 24,
  },
  { kind: 'richText', name: 'description', label: '详情（富文本，懒加载）', span: 24 },
];
