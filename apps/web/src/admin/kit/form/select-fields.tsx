'use client';

import { useQuery } from '@tanstack/react-query';
import { Cascader, TreeSelect } from 'antd';
import { defined } from '../props';

export interface TreeOption {
  title: string;
  value: string;
  children?: TreeOption[] | undefined;
  disabled?: boolean | undefined;
  selectable?: boolean | undefined;
}

export interface TreeSelectFieldProps {
  value?: string | string[] | undefined;
  onChange?: (value: string | string[] | undefined) => void;
  /** Static tree. Use this when the page already has the data. */
  treeData?: TreeOption[] | undefined;
  /** Async tree. Requires `cacheKey`; the result is cached and shared. */
  loadOptions?: (() => Promise<TreeOption[]>) | undefined;
  /** Cache identity for `loadOptions`, e.g. `'catalog.categories'`. */
  cacheKey?: string | undefined;
  multiple?: boolean | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  allowClear?: boolean | undefined;
  /** Only leaves are selectable. Handy for category pickers. */
  leafOnly?: boolean | undefined;
  /**
   * `multiple` only: ticking a parent sends the parent *and* everything under
   * it, not only the leaves. For a rule that matches a row's own id — a
   * coupon's 指定分类 — where a product filed under the parent itself counts too.
   */
  withParents?: boolean | undefined;
  id?: string | undefined;
}

/**
 * Tree picker for hierarchical references — product categories, org units.
 *
 * ```tsx
 * { kind: 'treeSelect', name: 'categoryId', label: '分类',
 *   cacheKey: 'catalog.categories', loadOptions: loadCategoryTree }
 * ```
 */
export function TreeSelectField({
  value,
  onChange,
  treeData,
  loadOptions,
  cacheKey,
  multiple = false,
  placeholder = '请选择',
  disabled,
  allowClear = true,
  leafOnly = false,
  withParents = false,
  id,
}: TreeSelectFieldProps) {
  const loaded = useQuery({
    queryKey: ['kit.treeSelect', cacheKey ?? ''],
    queryFn: () => loadOptions!(),
    enabled: Boolean(loadOptions && cacheKey),
    staleTime: 5 * 60_000,
  });

  const data = treeData ?? loaded.data ?? [];

  return (
    <TreeSelect
      {...defined({ id, disabled })}
      style={{ width: '100%' }}
      treeData={markSelectable(data, leafOnly) as never}
      value={value as never}
      onChange={(next) => onChange?.(next as string | string[] | undefined)}
      placeholder={placeholder}
      allowClear={allowClear}
      loading={loaded.isPending && Boolean(loadOptions)}
      treeNodeFilterProp="title"
      showSearch
      treeDefaultExpandAll
      {...(multiple ? { multiple: true as const, treeCheckable: true as const } : {})}
      {...(multiple && withParents ? { showCheckedStrategy: TreeSelect.SHOW_ALL } : {})}
    />
  );
}

function markSelectable(options: TreeOption[], leafOnly: boolean): TreeOption[] {
  if (!leafOnly) return options;
  return options.map((option) =>
    option.children?.length
      ? { ...option, selectable: false, children: markSelectable(option.children, leafOnly) }
      : option,
  );
}

export interface CascaderOption {
  label: string;
  value: string;
  children?: CascaderOption[] | undefined;
  isLeaf?: boolean | undefined;
  disabled?: boolean | undefined;
}

export interface CascaderFieldProps {
  /** The selected path, e.g. `['110000', '110100', '110101']`. */
  value?: string[] | undefined;
  onChange?: (value: string[] | undefined) => void;
  options?: CascaderOption[] | undefined;
  /** Async loader for the whole tree. Requires `cacheKey`. */
  loadOptions?: (() => Promise<CascaderOption[]>) | undefined;
  cacheKey?: string | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  /** Allow stopping at a province instead of requiring a district. */
  changeOnSelect?: boolean | undefined;
  allowClear?: boolean | undefined;
  id?: string | undefined;
}

/**
 * Multi-level picker, mainly province / city / district.
 *
 * ```tsx
 * { kind: 'cascader', name: 'area', label: '所在地区',
 *   cacheKey: 'system.areas', loadOptions: loadAreaTree }
 * ```
 */
export function CascaderField({
  value,
  onChange,
  options,
  loadOptions,
  cacheKey,
  placeholder = '请选择',
  disabled,
  changeOnSelect = false,
  allowClear = true,
  id,
}: CascaderFieldProps) {
  const loaded = useQuery({
    queryKey: ['kit.cascader', cacheKey ?? ''],
    queryFn: () => loadOptions!(),
    enabled: Boolean(loadOptions && cacheKey),
    staleTime: 30 * 60_000,
  });

  return (
    <Cascader
      {...defined({ id, disabled })}
      style={{ width: '100%' }}
      options={(options ?? loaded.data ?? []) as never}
      value={value as never}
      onChange={(next) => onChange?.((next as string[] | null) ?? undefined)}
      placeholder={placeholder}
      changeOnSelect={changeOnSelect}
      allowClear={allowClear}
      showSearch
    />
  );
}
