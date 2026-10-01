import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/admin/api/errors';
import { renderAdmin } from '@/test/render';

import { DetailDrawer, type DetailQuery } from './detail-drawer';

interface Row {
  name: string;
}

function query(overrides: Partial<DetailQuery<Row>> = {}): DetailQuery<Row> {
  return { data: undefined, isError: false, error: null, refetch: vi.fn(), ...overrides };
}

function render(props: { open?: boolean; query: DetailQuery<Row>; footer?: boolean }) {
  return renderAdmin(
    <DetailDrawer<Row>
      open={props.open ?? true}
      onClose={() => {}}
      title={(row) => `记录 ${row?.name ?? ''}`}
      query={props.query}
      footer={props.footer ? (row) => <button type="button">处理 {row.name}</button> : undefined}
    >
      {(row) => <p>名称：{row.name}</p>}
    </DetailDrawer>,
  );
}

describe('<DetailDrawer>', () => {
  it('shows a skeleton while loading, and no footer', () => {
    render({ query: query(), footer: true });
    expect(document.querySelector('.ant-skeleton')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /处理/ })).toBeNull();
  });

  it('says why it did not load, and 重试 reads again', async () => {
    const refetch = vi.fn();
    render({
      query: query({
        isError: true,
        error: new ApiError({ status: 404, code: 'NOT_FOUND', message: '售后单不存在' }),
        refetch,
      }),
    });
    expect(await screen.findByText('售后单不存在')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders the record, its title and its actions', () => {
    render({ query: query({ data: { name: '甲' } }), footer: true });
    expect(screen.getByText('名称：甲')).toBeInTheDocument();
    expect(screen.getByText('记录 甲')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '处理 甲' })).toBeInTheDocument();
  });

  it('keeps the record on screen while it closes', () => {
    const view = render({ query: query({ data: { name: '甲' } }) });
    view.rerender(
      <DetailDrawer<Row> open={false} onClose={() => {}} title="记录" query={query()}>
        {(row) => <p>名称：{row.name}</p>}
      </DetailDrawer>,
    );
    expect(screen.getByText('名称：甲')).toBeInTheDocument();
    expect(document.querySelector('.ant-skeleton')).toBeNull();
  });
});
