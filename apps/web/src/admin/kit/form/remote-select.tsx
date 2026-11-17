'use client';

import { useQuery } from '@tanstack/react-query';
import { Select, Spin } from 'antd';
import { useDeferredValue, useState, type CSSProperties, type ReactNode } from 'react';

import { defined } from '../props';

export interface RemoteSelectOption {
  value: string;
  label: ReactNode;
}

export interface RemoteSelectProps {
  value?: string | string[] | undefined;
  onChange?: ((value: string | string[] | undefined) => void) | undefined;
  /**
   * The first page for a keyword. Called with `''` when the control opens (or
   * when it is mounted), then once per distinct typed keyword. A caller that
   * has the server's `keyword` query sends it; the page size is the caller's.
   */
  loadOptions: (keyword: string) => Promise<readonly RemoteSelectOption[]>;
  /** Query identity, so two pickers on one page do not share results. */
  cacheKey: string;
  /**
   * Names for values that are already chosen but may fall outside the first
   * page — a list row's `labels` are such a source. Without it a selected value
   * the picker has never loaded shows as its raw id.
   */
  knownOptions?: readonly RemoteSelectOption[] | undefined;
  multiple?: boolean | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  /** `false` skips the request, for a control the viewer may not read. */
  active?: boolean | undefined;
  allowClear?: boolean | undefined;
  id?: string | undefined;
  'aria-label'?: string | undefined;
  'data-testid'?: string | undefined;
  style?: CSSProperties | undefined;
}

/**
 * A select whose options are searched on the server.
 *
 * The kit's plain `select` takes a fixed list, which silently truncates at
 * whatever page the page fetched: the 101st label cannot be chosen and there is
 * no sign that it exists. This control sends the typed keyword to the route
 * instead, and remembers every option it has seen so a multi-select's chosen
 * tags do not turn back into ids when the next search replaces the rows.
 *
 * `filterOption={false}` is deliberate: antd filtering the current page would
 * hide a server match the page does not contain.
 */
export function RemoteSelect({
  value,
  onChange,
  loadOptions,
  cacheKey,
  knownOptions,
  multiple = false,
  placeholder = '请选择',
  disabled,
  active = true,
  allowClear = true,
  id,
  'aria-label': ariaLabel,
  'data-testid': dataTestId,
  style,
}: RemoteSelectProps) {
  const [keyword, setKeyword] = useState('');
  // A keystroke is not an HTTP call: defer until the input settles.
  const term = useDeferredValue(keyword);

  const query = useQuery({
    queryKey: ['kit.remoteSelect', cacheKey, term],
    queryFn: () => loadOptions(term),
    enabled: active,
    staleTime: 30_000,
  });

  const loaded = query.data ?? [];
  // The option labels seen so far, for values that are no longer in `loaded`.
  // Merge during render (React's "adjust state when a prop changes" pattern):
  // an effect would paint one frame with the selected tag as its raw id.
  const loadedSignature = loaded.map((option) => String(option.value)).join('\u0000');
  const knownSignature = (knownOptions ?? []).map((option) => String(option.value)).join('\u0000');
  const [cache, setCache] = useState<{
    loadedSignature: string;
    knownSignature: string;
    options: ReadonlyMap<string, RemoteSelectOption>;
  }>(() => ({
    loadedSignature: '',
    knownSignature: '',
    options: new Map((knownOptions ?? []).map((option) => [option.value, option])),
  }));
  if (cache.loadedSignature !== loadedSignature || cache.knownSignature !== knownSignature) {
    const options = new Map(cache.options);
    for (const option of [...(knownOptions ?? []), ...loaded]) options.set(option.value, option);
    setCache({ loadedSignature, knownSignature, options });
  }

  const selected = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const options = [...loaded];
  for (const key of selected) {
    if (options.some((option) => option.value === key)) continue;
    const known = cache.options.get(key);
    if (known !== undefined) options.push(known);
  }

  return (
    <Select
      {...defined({ id, disabled, style, 'aria-label': ariaLabel, 'data-testid': dataTestId })}
      allowClear={allowClear}
      showSearch
      filterOption={false}
      optionFilterProp="label"
      value={value as never}
      onChange={(next: unknown) => {
        if (Array.isArray(next)) onChange?.(next.map(String));
        else onChange?.(next === undefined || next === null ? undefined : String(next));
      }}
      onSearch={setKeyword}
      onOpenChange={(open) => {
        // The next open starts from the whole list, not the last search.
        if (!open) setKeyword('');
      }}
      loading={query.isFetching}
      options={options as never}
      placeholder={placeholder}
      notFoundContent={
        query.isFetching ? (
          <Spin size="small" />
        ) : query.isError ? (
          '加载失败，请重新输入以重试'
        ) : (
          '没有匹配的选项'
        )
      }
      {...(multiple ? { mode: 'multiple' as const } : {})}
    />
  );
}
