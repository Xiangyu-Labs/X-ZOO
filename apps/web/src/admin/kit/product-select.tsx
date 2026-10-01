'use client';

import { useQuery } from '@tanstack/react-query';
import { Input, Select } from 'antd';
import { useState } from 'react';
import { catalogAdminProductList } from '@shop/contracts/catalog/catalog.product.admin.contract';

import { callRoute, useRouteQuery } from '@/admin/api';
import { useCan } from '@/admin/session';

import { defined } from './props';

/** The list's `ids` filter takes at most this many at once. */
const IDS_PER_READ = 100;
const DECIMAL_ID = /^[1-9]\d*$/;

export interface ProductSelectProps {
  /** One product id, or several with `multiple`. */
  value?: string | readonly string[] | null | undefined;
  /** `string | undefined` for one product, `string[]` with `multiple`. */
  onChange?: ((value: string | string[] | undefined) => void) | undefined;
  multiple?: boolean | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  id?: string | undefined;
}

/** Names for the ids already chosen, which the search page may not contain. */
async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let start = 0; start < ids.length; start += IDS_PER_READ) {
    const chunk = ids.slice(start, start + IDS_PER_READ);
    const page = await callRoute(catalogAdminProductList, {
      query: { page: 1, pageSize: chunk.length, ids: chunk.join(',') },
    });
    for (const item of page.items) names.set(item.id, item.name);
  }
  return names;
}

/**
 * 商品 by name instead of by a typed-in id: search the catalog's own list, pick.
 *
 * An id already chosen is shown by name too (read back with the list's `ids`
 * filter), so an edit form says 「有机坚果礼盒（#12）」, not 12. One the catalog no
 * longer has stays in the value as 「商品 #12」 for the operator to remove.
 *
 * Reads `catalog:product:read`. A role without it gets the plain id box it had
 * before, rather than a picker that toasts 没有权限 on every keystroke.
 */
export function ProductSelect({
  value,
  onChange,
  multiple = false,
  disabled,
  placeholder,
  id,
}: ProductSelectProps) {
  const canRead = useCan()(catalogAdminProductList.permission);
  const [keyword, setKeyword] = useState('');
  // Names of what was picked from a search, kept for when the next search no longer shows them.
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());

  const chosen: string[] = Array.isArray(value)
    ? [...(value as readonly string[])]
    : typeof value === 'string' && value !== ''
      ? [value]
      : [];

  const search = useRouteQuery(
    catalogAdminProductList,
    { query: { page: 1, pageSize: 20, ...(keyword ? { keyword } : {}) } },
    { enabled: canRead && !disabled },
  );
  // An id typed into the search finds that product too: operators copy ids from 商品列表.
  const typedId = DECIMAL_ID.test(keyword) ? keyword : undefined;
  const byId = useRouteQuery(
    catalogAdminProductList,
    { query: { page: 1, pageSize: 1, ids: typedId ?? '' } },
    { enabled: canRead && typedId !== undefined },
  );
  const lookup = chosen.filter((entry) => DECIMAL_ID.test(entry)).sort();
  const named = useQuery({
    queryKey: ['kit.productSelect.names', lookup],
    queryFn: () => namesOf(lookup),
    enabled: canRead && lookup.length > 0,
    staleTime: 5 * 60_000,
  });

  if (!canRead) {
    return multiple ? (
      <Select
        {...defined({ id, disabled })}
        mode="tags"
        value={chosen}
        placeholder="输入商品 ID 回车确认"
        open={false}
        onChange={(next: string[]) => onChange?.(next)}
        style={{ width: '100%' }}
      />
    ) : (
      <Input
        {...defined({ id, disabled })}
        value={chosen[0] ?? ''}
        placeholder="商品 ID"
        onChange={(event) => onChange?.(event.target.value || undefined)}
      />
    );
  }

  const found = new Map(picked);
  for (const [productId, name] of named.data ?? []) found.set(productId, name);
  const hits = [...(typedId ? (byId.data?.items ?? []) : []), ...(search.data?.items ?? [])];
  for (const item of hits) found.set(item.id, item.name);
  const nameOf = (productId: string) => {
    const name = found.get(productId);
    if (name !== undefined) return `${name}（#${productId}）`;
    return named.isPending ? `#${productId}` : `商品 #${productId}`;
  };
  const labels = new Map<string, string>();
  for (const productId of chosen) labels.set(productId, nameOf(productId));
  for (const item of hits) labels.set(item.id, nameOf(item.id));
  const options = [...labels].map(([optionValue, label]) => ({ value: optionValue, label }));

  return (
    <Select
      {...defined({ id, disabled })}
      allowClear
      {...(multiple ? { mode: 'multiple' as const } : {})}
      value={multiple ? chosen : chosen[0]}
      placeholder={placeholder ?? '搜索商品名称或 ID'}
      loading={search.isFetching || byId.isFetching}
      showSearch={{ filterOption: false, onSearch: setKeyword }}
      notFoundContent={search.isPending ? '搜索中…' : '没有找到商品'}
      onChange={(next: string | string[] | undefined) => {
        setKeyword('');
        setPicked(found);
        onChange?.(
          multiple ? ((next as string[] | undefined) ?? []) : (next as string | undefined),
        );
      }}
      options={options}
      style={{ width: '100%' }}
    />
  );
}
