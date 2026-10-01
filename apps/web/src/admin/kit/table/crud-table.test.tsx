import { defineRoute, id, instant, money, paged, pageQuery } from '@shop/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resetApiConfig } from '@/admin/api/config';
import { on, respondWithError, stubRoutes } from '@/test/api';
import { renderAdmin, zhName } from '@/test/render';

import { idColumn, instantColumn, moneyColumn, textColumn } from './columns';
import { columnsWidth, CrudTable } from './crud-table';
import { useMemoryUrlState, type TableUrlState } from './url-state';

const widget = z.object({ id, name: z.string(), price: money, createdAt: instant });
type Widget = z.infer<typeof widget>;

const listRoute = defineRoute({
  id: 'test.widgetList',
  method: 'GET',
  path: '/admin-api/widgets',
  auth: 'admin',
  permission: 'test:widget:list',
  summary: '列表',
  tags: ['test'],
  query: pageQuery.extend({
    keyword: z.string().optional(),
    status: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  }),
  response: paged(widget),
  examples: [{ name: 'ok', response: { items: [], total: 0, page: 1, pageSize: 20 } }],
});

const rows: Widget[] = Array.from({ length: 3 }, (_, index) => ({
  id: String(index + 1),
  name: `组件 ${index + 1}`,
  price: `${10 + index}.00`,
  createdAt: '2026-03-01T10:00:00+08:00',
}));

function stubList(): { urls: string[] } {
  const urls: string[] = [];
  stubRoutes([
    on(listRoute, (call) => {
      urls.push(call.url);
      return { items: rows, total: 42, page: 1, pageSize: 20 };
    }),
  ]);
  return { urls };
}

const columns = [
  idColumn<Widget>(),
  textColumn<Widget>({ title: '名称', dataIndex: 'name' }),
  moneyColumn<Widget>({ title: '价格', dataIndex: 'price' }),
  instantColumn<Widget>({ title: '创建时间', dataIndex: 'createdAt', sortable: true }),
];

/** Exposes the memory URL state so assertions can read it. */
function Harness({
  initial = {},
  onState,
  urlPrefix,
  fixedQuery,
}: {
  initial?: Record<string, string>;
  onState: (state: TableUrlState & { snapshot: Record<string, string> }) => void;
  urlPrefix?: string;
  fixedQuery?: Record<string, unknown>;
}) {
  const urlState = useMemoryUrlState(initial);
  onState(urlState);
  return (
    <CrudTable
      route={listRoute}
      columns={columns}
      urlState={urlState}
      {...(urlPrefix ? { urlPrefix } : {})}
      {...(fixedQuery ? { fixedQuery } : {})}
      filters={[
        { kind: 'text', name: 'keyword', label: '名称' },
        {
          kind: 'select',
          name: 'status',
          label: '状态',
          options: [
            { label: '启用', value: 'active' },
            { label: '停用', value: 'paused' },
          ],
        },
      ]}
    />
  );
}

afterEach(() => resetApiConfig());

describe('<CrudTable>', () => {
  it('asks for page 1 with the default page size and renders the rows', async () => {
    const { urls } = stubList();
    let state!: { snapshot: Record<string, string> };
    renderAdmin(<Harness onState={(next) => (state = next)} />);

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toBe('/admin-api/widgets?page=1&pageSize=20');
    expect(await screen.findByText('组件 1')).toBeInTheDocument();
    expect(screen.getByText('¥10.00')).toBeInTheDocument();
    expect(state.snapshot).toEqual({});
  });

  it('reads page, pageSize and sort out of the URL state', async () => {
    const { urls } = stubList();
    renderAdmin(
      <Harness
        initial={{ page: '3', pageSize: '10', sort: 'createdAt:desc', keyword: '搜' }}
        onState={() => {}}
      />,
    );

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toBe(
      '/admin-api/widgets?keyword=%E6%90%9C&page=3&pageSize=10&sortBy=createdAt&sortOrder=desc',
    );
  });

  it('writes filters back to the URL state and resets to page 1', async () => {
    const user = userEvent.setup();
    const { urls } = stubList();
    let state!: { snapshot: Record<string, string> };
    renderAdmin(<Harness initial={{ page: '4' }} onState={(next) => (state = next)} />);

    await waitFor(() => expect(urls).toHaveLength(1));

    await user.type(screen.getByTestId('filter-keyword'), '优惠');
    await user.click(screen.getByRole('button', { name: zhName('查询') }));

    await waitFor(() => expect(state.snapshot).toEqual({ page: '1', keyword: '优惠' }));
    await waitFor(() =>
      expect(urls.at(-1)).toBe('/admin-api/widgets?keyword=%E4%BC%98%E6%83%A0&page=1&pageSize=20'),
    );
  });

  it('clears every key it owns on reset', async () => {
    const user = userEvent.setup();
    stubList();
    let state!: { snapshot: Record<string, string> };
    renderAdmin(
      <Harness
        initial={{ page: '2', keyword: '旧', status: 'active' }}
        onState={(next) => (state = next)}
      />,
    );

    await user.click(screen.getByRole('button', { name: zhName('重置') }));
    await waitFor(() => expect(state.snapshot).toEqual({ page: '1' }));
  });

  it('namespaces its keys when a prefix is given', async () => {
    const user = userEvent.setup();
    stubList();
    let state!: { snapshot: Record<string, string> };
    renderAdmin(<Harness urlPrefix="widgets" onState={(next) => (state = next)} />);

    await user.type(screen.getByTestId('filter-keyword'), 'x');
    await user.click(screen.getByRole('button', { name: zhName('查询') }));

    await waitFor(() =>
      expect(state.snapshot).toEqual({ 'widgets.page': '1', 'widgets.keyword': 'x' }),
    );
  });

  it('turns a column sort into sortBy/sortOrder in the URL and the query', async () => {
    const user = userEvent.setup();
    const { urls } = stubList();
    let state!: { snapshot: Record<string, string> };
    renderAdmin(<Harness onState={(next) => (state = next)} />);

    await waitFor(() => expect(urls).toHaveLength(1));
    await user.click(screen.getByRole('columnheader', { name: /创建时间/ }));

    await waitFor(() => expect(state.snapshot['sort']).toBe('createdAt:asc'));
    await waitFor(() => expect(urls.at(-1)).toContain('sortBy=createdAt&sortOrder=asc'));
  });

  it('paginates through the URL state', async () => {
    const user = userEvent.setup();
    const { urls } = stubList();
    let state!: { snapshot: Record<string, string> };
    renderAdmin(<Harness onState={(next) => (state = next)} />);

    await waitFor(() => expect(urls).toHaveLength(1));
    // Row ids render as "2" too, so target the pagination item by its class,
    // and wait for it: the pager only appears once `total` has arrived.
    await waitFor(() => expect(document.querySelector('.ant-pagination-item-2')).not.toBeNull());
    await user.click(document.querySelector('.ant-pagination-item-2') as HTMLElement);

    await waitFor(() => expect(state.snapshot['page']).toBe('2'));
    await waitFor(() => expect(urls.at(-1)).toContain('page=2'));
  });

  it('shows the server error message in the empty state', async () => {
    stubRoutes([
      on(listRoute, () => respondWithError(500, { code: 'INTERNAL', message: '服务器开小差了' })),
    ]);
    renderAdmin(<Harness onState={() => {}} />);
    expect(await screen.findByText('服务器开小差了', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('goes back to page 1 when the page swaps what it lists, without asking for the old page', async () => {
    const { urls } = stubList();
    let state!: { snapshot: Record<string, string> };
    const view = renderAdmin(
      <Harness
        initial={{ page: '3' }}
        fixedQuery={{ status: 'active' }}
        onState={(next) => (state = next)}
      />,
    );
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain('page=3');

    view.rerender(
      <Harness
        initial={{ page: '3' }}
        fixedQuery={{ status: 'paused' }}
        onState={(next) => (state = next)}
      />,
    );

    await waitFor(() => expect(state.snapshot['page']).toBe('1'));
    const paused = urls.filter((url) => url.includes('status=paused'));
    expect(paused.length).toBeGreaterThan(0);
    expect(paused.every((url) => url.includes('page=1&'))).toBe(true);
  });

  it('steps back from an emptied last page to the last page with rows', async () => {
    const urls: string[] = [];
    stubRoutes([
      on(listRoute, (call) => {
        urls.push(call.url);
        const page = Number(call.query.get('page'));
        // 41 rows: page 3 of 20 had one, and it was just deleted.
        return page === 3
          ? { items: [], total: 40, page: 3, pageSize: 20 }
          : { items: rows, total: 40, page, pageSize: 20 };
      }),
    ]);
    let state!: { snapshot: Record<string, string> };
    renderAdmin(<Harness initial={{ page: '3' }} onState={(next) => (state = next)} />);

    await waitFor(() => expect(state.snapshot['page']).toBe('2'));
    expect(await screen.findByText('组件 1')).toBeInTheDocument();
  });

  it('hands a function toolbar the filters, without paging, sort or fixedQuery, and the total', async () => {
    stubList();
    function Toolbarred() {
      const urlState = useMemoryUrlState({
        keyword: '红',
        page: '2',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });
      return (
        <CrudTable
          route={listRoute}
          columns={columns}
          urlState={urlState}
          fixedQuery={{ status: 'active' }}
          filters={[{ kind: 'text', name: 'keyword', label: '名称' }]}
          toolbar={({ filters, total }) => (
            <span data-testid="toolbar">{JSON.stringify({ filters, total })}</span>
          )}
        />
      );
    }
    renderAdmin(<Toolbarred />);

    await waitFor(() =>
      expect(screen.getByTestId('toolbar').textContent).toBe(
        JSON.stringify({ filters: { keyword: '红' }, total: 42 }),
      ),
    );
  });
});

// A fixed column lays the table out as `table-layout: fixed`; a scroll width of
// just the declared widths left every unsized column (金额, 备注) 29px wide.
describe('columnsWidth', () => {
  it('counts a minimum for columns without a width, and the selection column', () => {
    const sized = [{ key: 'a', width: 100 }, { key: 'b' }, { key: 'c', width: 60 }];
    expect(columnsWidth(sized)).toBe(100 + 140 + 60);
    expect(columnsWidth(sized, true)).toBe(100 + 140 + 60 + 48);
    expect(columnsWidth([{ key: 'g', children: [{ key: 'x', width: 80 }, { key: 'y' }] }])).toBe(
      80 + 140,
    );
  });
});
