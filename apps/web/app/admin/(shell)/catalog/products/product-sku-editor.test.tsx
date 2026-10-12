import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogAdminSkuMatrix } from '@shop/contracts/catalog/catalog.product.admin.contract';
import {
  productSkuInput,
  type ProductSkuInput,
  type ProductSpecInput,
} from '@shop/contracts/catalog/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { withStubAssets } from '@/test/asset-source';
import { renderAdmin } from '@/test/render';

import {
  SkuMatrixEditor,
  blankSku,
  mergeSingleValueSpecs,
  singleValueSpecs,
} from './product-sku-editor';

/**
 * The SKU table under 规格项: a price that can be emptied, rows that follow the spec items,
 * the 合并为一个规格项 way out of "one item per variant", and pictures from the library.
 */

/** The server's cartesian product (`skuMatrix` in core), in axis order. */
const matrix = on(catalogAdminSkuMatrix, (call) => {
  const { specs } = call.body as { specs: ProductSpecInput[] };
  let rows: Record<string, string>[] = [{}];
  for (const spec of specs)
    rows = rows.flatMap((row) => spec.values.map((item) => ({ ...row, [spec.name]: item.value })));
  return {
    rows: rows.map((specValues) => ({
      specValues,
      specText: specs.map((spec) => specValues[spec.name]).join('|'),
    })),
  };
});

afterEach(() => resetApiConfig());

/** The editor with the form's two fields as local state, as `ProductEditorPage` wires them. */
function Harness({
  initialSpecs,
  initialRows,
  onRows,
}: {
  initialSpecs: ProductSpecInput[];
  initialRows: ProductSkuInput[];
  onRows?: (rows: ProductSkuInput[]) => void;
}) {
  const [specs, setSpecs] = useState(initialSpecs);
  const [rows, setRows] = useState(initialRows);
  return (
    <>
      <span data-testid="specs">{JSON.stringify(specs)}</span>
      <SkuMatrixEditor
        specs={specs}
        specMode
        kind="physical"
        value={rows}
        onChange={(next) => {
          setRows(next);
          onRows?.(next);
        }}
        onSpecsChange={setSpecs}
      />
    </>
  );
}

const twoItems: ProductSpecInput[] = [
  { name: 'Galaku 小魔方 粉色', values: [{ value: '6975488691535' }] },
  { name: 'Galaku 小魔方 紫色', values: [{ value: '6975488691528' }] },
];

describe('price', () => {
  it('a new row starts empty and an empty price says 请填写售价', () => {
    const row = blankSku({ 颜色: '粉色' });
    expect(row.price).toBe('');
    const result = productSkuInput.safeParse(row);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('请填写售价');
  });

  it('clearing 0.00 leaves the box empty instead of writing 0.00 back', async () => {
    stubRoutes([matrix]);
    let last: ProductSkuInput[] = [];
    renderAdmin(
      withStubAssets(
        <Harness
          initialSpecs={[{ name: '颜色', values: [{ value: '粉色' }] }]}
          initialRows={[{ ...blankSku({ 颜色: '粉色' }), price: '0.00', isDefault: true }]}
          onRows={(rows) => (last = rows)}
        />,
      ),
    );
    const box = screen.getAllByPlaceholderText('请填写')[0] as HTMLInputElement;
    expect(box.value).toBe('0.00');
    fireEvent.change(box, { target: { value: '' } });
    expect(box.value).toBe('');
    expect(last[0]?.price).toBe('');
  });
});

describe('one item per variant', () => {
  it('is spotted only when every item holds a single value', () => {
    expect(singleValueSpecs(twoItems)).toBe(true);
    expect(singleValueSpecs(twoItems.slice(0, 1))).toBe(false);
    expect(
      singleValueSpecs([
        { name: '颜色', values: [{ value: '粉' }, { value: '紫' }] },
        { name: '尺码', values: [{ value: 'M' }] },
      ]),
    ).toBe(false);
  });

  it('merges the names into one 款式 item, the barcodes into 条码', () => {
    const merged = mergeSingleValueSpecs(twoItems);
    expect(merged.specs).toEqual([
      { name: '款式', values: [{ value: 'Galaku 小魔方 粉色' }, { value: 'Galaku 小魔方 紫色' }] },
    ]);
    expect([...merged.seed.values()]).toEqual([
      { barCode: '6975488691535' },
      { barCode: '6975488691528' },
    ]);
  });

  it('合并为一个规格项 turns the single row into one row per variant', async () => {
    stubRoutes([matrix]);
    let last: ProductSkuInput[] = [];
    renderAdmin(
      withStubAssets(
        <Harness
          initialSpecs={twoItems}
          initialRows={[
            {
              ...blankSku({
                'Galaku 小魔方 粉色': '6975488691535',
                'Galaku 小魔方 紫色': '6975488691528',
              }),
              isDefault: true,
            },
          ]}
          onRows={(rows) => (last = rows)}
        />,
      ),
    );

    expect(screen.getByText(/现在只会生成 1 个 SKU/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /合并为一个规格项/ }));

    await waitFor(() => expect(last).toHaveLength(2));
    expect(last.map((row) => row.specValues)).toEqual([
      { 款式: 'Galaku 小魔方 粉色' },
      { 款式: 'Galaku 小魔方 紫色' },
    ]);
    expect(last.map((row) => row.barCode)).toEqual(['6975488691535', '6975488691528']);
    expect(last.filter((row) => row.isDefault)).toHaveLength(1);
    expect(screen.getByTestId('specs').textContent).toContain('"name":"款式"');
    expect(screen.queryByText(/现在只会生成 1 个 SKU/)).not.toBeInTheDocument();
  });
});

describe('rows follow the spec items', () => {
  it('a value added to an item adds its row and keeps the others’ prices', async () => {
    const calls = stubRoutes([matrix]);
    let last: ProductSkuInput[] = [];
    function Grows() {
      const [specs, setSpecs] = useState<ProductSpecInput[]>([
        { name: '颜色', values: [{ value: '粉色' }] },
      ]);
      const [rows, setRows] = useState<ProductSkuInput[]>([
        { ...blankSku({ 颜色: '粉色' }), price: '78.99', isDefault: true },
      ]);
      return (
        <>
          <button
            type="button"
            onClick={() =>
              setSpecs([{ name: '颜色', values: [{ value: '粉色' }, { value: '紫色' }] }])
            }
          >
            加紫色
          </button>
          <SkuMatrixEditor
            specs={specs}
            specMode
            kind="physical"
            value={rows}
            onChange={(next) => {
              setRows(next);
              last = next;
            }}
          />
        </>
      );
    }
    renderAdmin(withStubAssets(<Grows />));

    // Opening the editor leaves the saved rows alone.
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '加紫色' }));

    await waitFor(() => expect(last).toHaveLength(2), { timeout: 2000 });
    expect(last[0]).toMatchObject({ specValues: { 颜色: '粉色' }, price: '78.99' });
    expect(last[1]).toMatchObject({ specValues: { 颜色: '紫色' }, price: '' });
  });
});

describe('picture', () => {
  it('is picked from the library and can be cleared', async () => {
    stubRoutes([matrix]);
    let last: ProductSkuInput[] = [];
    renderAdmin(
      withStubAssets(
        <Harness
          initialSpecs={[{ name: '颜色', values: [{ value: '粉色' }] }]}
          initialRows={[{ ...blankSku({ 颜色: '粉色' }), price: '1.00', isDefault: true }]}
          onRows={(rows) => (last = rows)}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: '选择规格图片 1' }));
    fireEvent.click(await screen.findByTestId('asset-2'));
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
    await waitFor(() => expect(last[0]?.imageUrl).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '清除规格图片 1' }));
    expect(last[0]?.imageUrl).toBeUndefined();
  });
});
