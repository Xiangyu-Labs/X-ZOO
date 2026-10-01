import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin, zhName } from '@/test/render';

import {
  columnsForWidth,
  FilterBar,
  firstRowCount,
  labelWidthEm,
  type FilterSpec,
} from './filter-bar';

const FIVE: FilterSpec[] = [
  { kind: 'text', name: 'keyword', label: '单号', placeholder: '售后单号或订单号' },
  { kind: 'select', name: 'status', label: '状态', options: [{ value: 'a', label: 'A' }] },
  { kind: 'select', name: 'kind', label: '类型', options: [{ value: 'b', label: 'B' }] },
  { kind: 'number', name: 'userId', label: '用户 ID' },
  { kind: 'dateRange', names: ['createdFrom', 'createdTo'], label: '申请时间' },
];

beforeEach(() => window.localStorage.clear());

describe('<FilterBar>', () => {
  it('sends an amount as a money string and a search without its stray spaces', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    renderAdmin(
      <FilterBar
        filters={[
          { kind: 'text', name: 'keyword', label: '名称' },
          { kind: 'money', name: 'priceFrom', label: '价格从' },
        ]}
        values={{}}
        onApply={onApply}
      />,
    );

    await user.type(screen.getByTestId('filter-keyword'), '  T 恤 ');
    await user.type(screen.getByPlaceholderText('0.00'), '100');
    await user.click(screen.getByRole('button', { name: zhName('查询') }));

    // The contract's money is "100.00": "100" was a 422 on every search.
    expect(onApply).toHaveBeenLastCalledWith({ keyword: 'T 恤', priceFrom: '100.00' });
  });

  it('drops a search that is only spaces', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    renderAdmin(
      <FilterBar
        filters={[{ kind: 'text', name: 'keyword', label: '名称' }]}
        values={{}}
        onApply={onApply}
      />,
    );

    await user.type(screen.getByTestId('filter-keyword'), '   ');
    await user.click(screen.getByRole('button', { name: zhName('查询') }));

    expect(onApply).toHaveBeenLastCalledWith({ keyword: undefined });
  });

  // 3 cells per row before the bar is measured (and always in happy-dom).
  it('folds a bar longer than one row to the first row, with 查询 beside it', async () => {
    const user = userEvent.setup();
    renderAdmin(<FilterBar filters={FIVE} values={{}} onApply={vi.fn()} />);

    expect(screen.getByTestId('filter-keyword')).toBeTruthy();
    expect(screen.getByTestId('filter-status')).toBeTruthy();
    expect(screen.queryByTestId('filter-kind')).toBeNull();

    await user.click(screen.getByRole('button', { name: /展\s*开/ }));
    expect(screen.getByTestId('filter-kind')).toBeTruthy();
    expect(screen.getByText('申请时间')).toBeTruthy();
    expect(screen.getByRole('button', { name: /收\s*起/ })).toBeTruthy();
  });

  it('keeps a folded filter in sight when the URL uses it', () => {
    renderAdmin(<FilterBar filters={FIVE} values={{ kind: 'b' }} onApply={vi.fn()} />);

    expect(screen.getByTestId('filter-kind')).toBeTruthy();
    // Folding it away would hide why the list is short.
    expect(screen.queryByRole('button', { name: /收\s*起|展\s*开/ })).toBeNull();
  });

  it('gives every label in a bar the width of the longest', () => {
    const { container } = renderAdmin(
      <FilterBar filters={FIVE.slice(0, 2)} values={{}} onApply={vi.fn()} />,
    );
    const widths = [...container.querySelectorAll<HTMLElement>('.ant-form-item-label')].map(
      (label) => label.style.flex,
    );
    expect(widths).toHaveLength(2);
    expect(new Set(widths).size).toBe(1);
  });

  it('puts 查询/重置 in the last column, wherever the last row ends', () => {
    renderAdmin(<FilterBar filters={FIVE.slice(0, 1)} values={{}} onApply={vi.fn()} />);
    expect(screen.getByTestId('filter-actions').style.gridColumn).toBe('-2 / -1');
  });
});

describe('filter bar layout', () => {
  it('fits about 280px per cell, at most four', () => {
    expect(columnsForWidth(375)).toBe(1);
    expect(columnsForWidth(700)).toBe(2);
    expect(columnsForWidth(1017)).toBe(3);
    expect(columnsForWidth(1700)).toBe(4);
  });

  it('sizes labels by the longest, counting CJK as 1em and ASCII as about half', () => {
    expect(labelWidthEm(['状态', '用户 ID'])).toBeCloseTo(2 + 3 * 0.55 + 1.25);
    // Capped, so one long label cannot squeeze every input.
    expect(labelWidthEm(['抬头 / 税号 / 订单号'])).toBe(7.25);
  });

  it('leaves room for the buttons on the first row', () => {
    expect(firstRowCount(FIVE.slice(0, 2), 3)).toEqual({ count: 2, collapsible: false });
    expect(firstRowCount(FIVE.slice(0, 3), 3)).toEqual({ count: 2, collapsible: true });
    expect(firstRowCount(FIVE, 4)).toEqual({ count: 3, collapsible: true });
    // A dateRange with times takes two cells.
    const wide: FilterSpec[] = [
      { kind: 'dateRange', names: ['a', 'b'], label: '时间', showTime: true },
      { kind: 'text', name: 'c', label: '单号' },
    ];
    expect(firstRowCount(wide, 3)).toEqual({ count: 1, collapsible: true });
    // A phone shows its first filter even though nothing fits beside the buttons.
    expect(firstRowCount(FIVE, 1)).toEqual({ count: 1, collapsible: true });
  });
});
