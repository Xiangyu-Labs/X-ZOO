'use client';

import { ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Space, Table, Typography } from 'antd';
import type { ColumnsType, TableProps } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ParamsInputOf } from '../../api/call-route';
import type { AnyRouteDef, ResponseOf } from '../../api/contracts';
import { errorMessage } from '../../api/errors';
import { useRouteQuery } from '../../api/hooks';
import { stableInput } from '../../api/query-keys';
import { FilterBar, filterKeys, type FilterSpec } from './filter-bar';
import { defined } from '../props';
import { prefixKey, useNextUrlState, type TableUrlState } from './url-state';

/** The item type of a route whose response is `paged(item)`. */
export type PagedItemOf<R extends AnyRouteDef> =
  ResponseOf<R> extends { items: readonly (infer I)[] } ? I : never;

export interface BatchActionContext<T> {
  selectedRowKeys: React.Key[];
  selectedRows: T[];
  clear: () => void;
}

/** What a toolbar rendered as a function sees: the list as it is filtered now. */
export interface ToolbarContext {
  /** The filter bar's values as query keys, without paging, sorting or `fixedQuery`. */
  filters: Record<string, unknown>;
  /** Rows the filters match; `undefined` while the list for these filters is loading. */
  total: number | undefined;
}

export interface CrudTableProps<R extends AnyRouteDef, T = PagedItemOf<R>> {
  /** A list route whose response is `paged(item)`. */
  route: R;
  columns: ColumnsType<T>;
  /** Default `'id'`. */
  rowKey?: (keyof T & string) | ((row: T) => React.Key) | undefined;
  /** Filter bar; each `name` is a query key of the route. */
  filters?: readonly FilterSpec[] | undefined;
  /** Path params for nested lists, e.g. `{ orderId }`. */
  params?: ParamsInputOf<R> | undefined;
  /** Query values that are never URL-synced and never shown in the filter bar. */
  fixedQuery?: Record<string, unknown> | undefined;
  /**
   * The table's own actions, left above the table: 新建 first (primary), then
   * 导出, 导入 and the like. 刷新 is always on the right. Page-level actions
   * that are not about this list belong in `PageContainer`'s `extra`.
   * A function receives the current filters and total, for an action on
   * "everything listed".
   */
  toolbar?: ReactNode | ((context: ToolbarContext) => ReactNode) | undefined;
  /** Rendered in a banner when rows are selected. Enables row selection. */
  batchActions?: ((context: BatchActionContext<T>) => ReactNode) | undefined;
  defaultPageSize?: number | undefined;
  pageSizeOptions?: number[] | undefined;
  /** Namespace for the URL keys, needed when a page holds more than one table. */
  urlPrefix?: string | undefined;
  /** Override the URL binding. Tests pass `useMemoryUrlState()`. */
  urlState?: TableUrlState | undefined;
  /** Query keys used for server-side sorting. Default `sortBy` / `sortOrder`. */
  sortKeys?: { field: string; order: string } | undefined;
  size?: 'small' | 'middle' | 'large' | undefined;
  /**
   * The least width the table scrolls at. It never goes below what the
   * columns need (`columnsWidth`), so a stale number cannot squeeze a column;
   * without it the table scrolls once its columns stop fitting, and the fixed
   * 操作 column stays put.
   */
  scrollX?: number | undefined;
  emptyText?: ReactNode | undefined;
  expandable?: TableProps<T>['expandable'] | undefined;
  /** Card title above the filter bar. Omit when inside a `PageContainer`. */
  title?: ReactNode | undefined;
  bordered?: boolean | undefined;
  /** Called whenever a page of data arrives. For summaries above the table. */
  onData?: ((data: ResponseOf<R>) => void) | undefined;
}

const DEFAULT_SORT_KEYS = { field: 'sortBy', order: 'sortOrder' } as const;

/** What a column without a `width` is given when the table works out its scroll width. */
const UNSIZED_COLUMN_WIDTH = 140;
const SELECTION_COLUMN_WIDTH = 48;

/**
 * The width the columns need: their declared widths, and a minimum for those
 * without one.
 *
 * A fixed column makes antd lay the table out as `table-layout: fixed`. Under
 * `scroll.x: 'max-content'` the table is then exactly as wide as the declared
 * widths, and every column without one (金额, 备注) collapses to nothing. With
 * this width the table fills the page when it can, the unsized columns share
 * what is left, and it scrolls only when there is not room for all of them.
 */
export function columnsWidth<T>(columns: ColumnsType<T>, selectable = false): number {
  const sum = (list: ColumnsType<T>): number =>
    list.reduce((total, column) => {
      if ('children' in column && column.children) return total + sum(column.children);
      return total + (typeof column.width === 'number' ? column.width : UNSIZED_COLUMN_WIDTH);
    }, 0);
  return sum(columns) + (selectable ? SELECTION_COLUMN_WIDTH : 0);
}

/**
 * The standard admin list screen.
 *
 * Give it a list `RouteDef` and columns; it handles server pagination and
 * sorting, a declarative filter bar, URL state (so a filtered list is a
 * shareable link and survives a refresh), row selection with batch actions,
 * a refresh button and the empty state.
 *
 * ```tsx
 * <CrudTable
 *   route={couponList}
 *   rowKey="id"
 *   filters={[
 *     { kind: 'text', name: 'keyword', label: '名称' },
 *     { kind: 'select', name: 'status', label: '状态', options: statusOptions(COUPON_STATUS) },
 *     { kind: 'dateRange', names: ['createdFrom', 'createdTo'], label: '创建时间' },
 *   ]}
 *   toolbar={<Can permission="coupon:template:create"><Button type="primary" onClick={modal.show}>新建</Button></Can>}
 *   columns={[
 *     idColumn(),
 *     textColumn({ title: '名称', dataIndex: 'name', ellipsis: true }),
 *     moneyColumn({ title: '面额', dataIndex: 'value' }),
 *     enumColumn({ title: '状态', dataIndex: 'status', map: COUPON_STATUS }),
 *     instantColumn({ title: '创建时间', dataIndex: 'createdAt', sortable: true }),
 *     actionsColumn({ render: (row) => <ConfirmButton … /> }),
 *   ]}
 * />
 * ```
 */
export function CrudTable<R extends AnyRouteDef, T = PagedItemOf<R>>(props: CrudTableProps<R, T>) {
  if (props.urlState) return <CrudTableInner {...props} urlState={props.urlState} />;
  return <WithRouterUrlState {...props} />;
}

function WithRouterUrlState<R extends AnyRouteDef, T>(props: CrudTableProps<R, T>) {
  const urlState = useNextUrlState();
  return <CrudTableInner {...props} urlState={urlState} />;
}

function CrudTableInner<R extends AnyRouteDef, T>({
  route,
  columns,
  rowKey = 'id' as keyof T & string,
  filters = [],
  params,
  fixedQuery,
  toolbar,
  batchActions,
  defaultPageSize = 20,
  pageSizeOptions = [10, 20, 50, 100],
  urlPrefix,
  urlState,
  sortKeys = DEFAULT_SORT_KEYS,
  size = 'middle',
  scrollX,
  emptyText,
  expandable,
  title,
  bordered = false,
  onData,
}: CrudTableProps<R, T> & { urlState: TableUrlState }) {
  const key = useCallback((name: string) => prefixKey(urlPrefix, name), [urlPrefix]);
  const { read, write } = urlState;

  const urlPage = toPositiveInt(read(key('page')), 1);
  const pageSize = toPositiveInt(read(key('pageSize')), defaultPageSize);

  // A page number belongs to the list it was chosen on. When the page swaps
  // what the table lists (a status tab passes `fixedQuery`), page 3 of 待发货
  // is not page 3 of 已完成: go back to 1 — in this render, so the old page is
  // never requested for the new list, and in the URL just after.
  const fixedSignature = JSON.stringify(stableInput(fixedQuery ?? {}));
  const [listedUnder, setListedUnder] = useState(fixedSignature);
  const [resetting, setResetting] = useState(false);
  if (listedUnder !== fixedSignature) {
    setListedUnder(fixedSignature);
    setResetting(urlPage !== 1);
  } else if (resetting && urlPage === 1) {
    setResetting(false);
  }
  const page = resetting || listedUnder !== fixedSignature ? 1 : urlPage;
  useEffect(() => {
    if (resetting) write({ [key('page')]: '1' });
  }, [resetting, write, key]);
  const sortRaw = read(key('sort'));

  const filterValues = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    for (const spec of filters) for (const name of filterKeys(spec)) out[name] = read(key(name));
    return out;
  }, [filters, read, key]);

  const filterQuery = useMemo(() => {
    const built: Record<string, unknown> = {};
    for (const spec of filters) {
      for (const name of filterKeys(spec)) {
        const value = filterValues[name];
        if (value === undefined || value === '') continue;
        built[name] =
          spec.kind === 'select' && spec.multiple ? value.split(',').filter(Boolean) : value;
      }
    }
    return built;
  }, [filters, filterValues]);

  const query = useMemo(() => {
    const built: Record<string, unknown> = { page, pageSize, ...fixedQuery, ...filterQuery };
    if (sortRaw) {
      const [field, order] = sortRaw.split(':');
      if (field && (order === 'asc' || order === 'desc')) {
        built[sortKeys.field] = field;
        built[sortKeys.order] = order;
      }
    }
    return built;
  }, [page, pageSize, fixedQuery, filterQuery, sortRaw, sortKeys]);

  const result = useRouteQuery(
    route,
    { ...(params !== undefined ? { params } : {}), query } as never,
    { placeholderData: keepPreviousData },
  );

  const data = result.data as { items: T[]; total: number } | undefined;

  useEffect(() => {
    if (result.data) onData?.(result.data);
  }, [result.data, onData]);

  // Deleting the last rows of the last page leaves an empty page past the end:
  // step back to the last page that has rows instead of showing 暂无数据 over
  // a pager that says there are some.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const pastTheEnd =
    data !== undefined && !result.isPlaceholderData && data.items.length === 0 && page > lastPage;
  useEffect(() => {
    if (pastTheEnd) write({ [key('page')]: String(lastPage) });
  }, [pastTheEnd, lastPage, write, key]);

  // Selection belongs to one page of results. Rather than clearing it in an
  // effect when the page or the filters move, it is stamped with the query it
  // was made against and simply stops applying — no extra render.
  const querySignature = `${page}|${pageSize}|${sortRaw ?? ''}|${JSON.stringify(filterValues)}`;
  const [selection, setSelection] = useState<{
    signature: string;
    keys: React.Key[];
    rows: T[];
  }>({ signature: querySignature, keys: [], rows: [] });

  const current = selection.signature === querySignature ? selection : null;
  const selectedRowKeys = current?.keys ?? [];
  const selectedRows = current?.rows ?? [];
  const clearSelection = useCallback(
    () => setSelection({ signature: querySignature, keys: [], rows: [] }),
    [querySignature],
  );

  const applyFilters = (next: Record<string, string | undefined>): void => {
    const patch: Record<string, string | undefined> = { [key('page')]: '1' };
    for (const [name, value] of Object.entries(next)) patch[key(name)] = value;
    write(patch);
  };

  const handleTableChange: NonNullable<TableProps<T>['onChange']> = (
    pagination,
    _tableFilters,
    sorter,
  ) => {
    const single = Array.isArray(sorter) ? sorter[0] : sorter;
    const field = single?.field;
    const order = single?.order;
    const sortValue =
      field && order
        ? `${Array.isArray(field) ? field.join('.') : String(field)}:${order === 'ascend' ? 'asc' : 'desc'}`
        : undefined;

    write({
      [key('page')]: String(pagination.current ?? 1),
      [key('pageSize')]: String(pagination.pageSize ?? pageSize),
      [key('sort')]: sortValue,
    });
  };

  const body = (
    <>
      {filters.length > 0 ? (
        <FilterBar
          filters={filters}
          values={filterValues}
          onApply={applyFilters}
          loading={result.isFetching}
        />
      ) : null}

      <TableToolbar onRefresh={() => result.refetch()} refreshing={result.isFetching}>
        {typeof toolbar === 'function'
          ? toolbar({
              filters: filterQuery,
              // A placeholder is the previous filters' page: its total is not these filters'.
              total: data && !result.isPlaceholderData ? data.total : undefined,
            })
          : toolbar}
      </TableToolbar>

      {batchActions && selectedRowKeys.length > 0 ? (
        <Alert
          type="info"
          style={{ marginBottom: 12 }}
          message={
            <Space wrap>
              <Typography.Text>已选择 {selectedRowKeys.length} 项</Typography.Text>
              {batchActions({ selectedRowKeys, selectedRows, clear: clearSelection })}
              <Button type="link" size="small" onClick={clearSelection}>
                取消选择
              </Button>
            </Space>
          }
        />
      ) : null}

      <Table<T>
        rowKey={rowKey as never}
        size={size}
        bordered={bordered}
        columns={columns}
        dataSource={data?.items ?? []}
        loading={result.isFetching && !data}
        {...defined({ expandable })}
        onChange={handleTableChange}
        locale={{
          emptyText: result.isError ? (
            <Empty description={errorMessage(result.error, '加载失败，请重试')} />
          ) : (
            <Empty description={emptyText ?? '暂无数据'} />
          ),
        }}
        scroll={{ x: Math.max(scrollX ?? 0, columnsWidth(columns, batchActions !== undefined)) }}
        {...(batchActions
          ? {
              rowSelection: {
                selectedRowKeys,
                onChange: (keys: React.Key[], rows: T[]) =>
                  setSelection({ signature: querySignature, keys, rows }),
              },
            }
          : {})}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: pageSizeOptions.map(String),
          showTotal: (total) => `共 ${total} 条`,
        }}
      />
    </>
  );

  return title ? (
    <Card title={title} size="small">
      {body}
    </Card>
  ) : (
    body
  );
}

/**
 * The row above every admin table: the table's actions on the left (新建
 * first), 刷新 on the right. `CrudTable` renders it; a table that is not a
 * `CrudTable` (a tree, an unpaged list) renders it too, so every list reads the
 * same way.
 */
export function TableToolbar({
  children,
  onRefresh,
  refreshing = false,
}: {
  children?: ReactNode;
  onRefresh?: (() => unknown) | undefined;
  refreshing?: boolean | undefined;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12,
        flexWrap: 'wrap',
      }}
    >
      <Space wrap>{children}</Space>
      {onRefresh ? (
        <Button
          icon={<ReloadOutlined />}
          onClick={() => onRefresh()}
          loading={refreshing}
          aria-label="刷新"
        >
          刷新
        </Button>
      ) : null}
    </div>
  );
}

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
