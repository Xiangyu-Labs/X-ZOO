import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table } from 'antd';
import { describe, expect, it } from 'vitest';

import { renderAdmin } from '@/test/render';

import { codeColumn, codeWidth, errorColumn } from './columns';

interface Row {
  id: string;
  orderId: string | null;
  orderNo: string | null;
}

const rows: Row[] = [
  { id: '1', orderId: '42', orderNo: 'O202610010000001234' },
  { id: '2', orderId: null, orderNo: 'O202610010000005678' },
  { id: '3', orderId: null, orderNo: null },
];

describe('codeColumn', () => {
  it('shows the whole number, links it when there is a record, and offers a copy', () => {
    renderAdmin(
      <Table<Row>
        rowKey="id"
        dataSource={rows}
        pagination={false}
        columns={[
          codeColumn<Row>({
            title: '订单号',
            dataIndex: 'orderNo',
            href: (row) => (row.orderId ? `/admin/orders/${row.orderId}` : null),
          }),
        ]}
      />,
    );

    const linked = screen.getByRole('link', { name: 'O202610010000001234' });
    expect(linked).toHaveAttribute('href', '/admin/orders/42');

    const [first, second, third] = screen.getAllByRole('row').slice(1);
    if (!first || !second || !third) throw new Error('缺行');
    expect(within(first).getByRole('button', { name: /复制/ })).toBeInTheDocument();
    // No order behind it: the number is still there to copy, just not a link.
    expect(within(second).getByText('O202610010000005678').closest('a')).toBeNull();
    expect(within(second).getByRole('button', { name: /复制/ })).toBeInTheDocument();
    expect(within(third).getByText('—')).toBeInTheDocument();
    expect(within(third).queryByRole('button', { name: /复制/ })).not.toBeInTheDocument();
  });

  // Fixed-layout tables squeeze a column without a width, and a number that
  // cannot wrap then runs into the next cell.
  it('always has a width that fits the whole number', () => {
    expect(codeColumn<Row>({ title: '订单号', dataIndex: 'orderNo' }).width).toBe(codeWidth(26));
    expect(
      codeColumn<Row>({ title: '微信单号', dataIndex: 'orderNo', chars: 28 }).width,
    ).toBeGreaterThan(codeWidth(26));
    expect(codeColumn<Row>({ title: '订单号', dataIndex: 'orderNo', width: 300 }).width).toBe(300);
  });
});

interface Failure {
  id: string;
  lastError: string | null;
  lastErrorSummary: string | null;
}

describe('errorColumn', () => {
  it('shows staff the Chinese summary and keeps the raw text under 技术详情', async () => {
    renderAdmin(
      <Table<Failure>
        rowKey="id"
        dataSource={[
          {
            id: '1',
            lastError: '通知发送失败：wechatOa 40037: invalid template_id',
            lastErrorSummary: '公众号：模板 ID 不对，请到公众平台核对（错误码 40037）',
          },
          { id: '2', lastError: null, lastErrorSummary: null },
        ]}
        pagination={false}
        columns={[
          errorColumn<Failure>({
            title: '最后错误',
            summary: 'lastErrorSummary',
            detail: 'lastError',
          }),
        ]}
      />,
    );

    const [failed, clean] = screen.getAllByRole('row').slice(1);
    expect(
      within(failed!).getByText('公众号：模板 ID 不对，请到公众平台核对（错误码 40037）'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/invalid template_id/)).not.toBeInTheDocument();
    expect(within(clean!).getByText('—')).toBeInTheDocument();
    expect(within(clean!).queryByRole('button', { name: '技术详情' })).not.toBeInTheDocument();

    await userEvent.click(within(failed!).getByRole('button', { name: '技术详情' }));
    expect(
      await screen.findByText('通知发送失败：wechatOa 40037: invalid template_id'),
    ).toBeInTheDocument();
    expect(screen.getByText('供技术人员排查问题，可复制后发给技术支持。')).toBeInTheDocument();
  });
});
