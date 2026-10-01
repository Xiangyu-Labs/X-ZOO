import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogAdminProductList } from '@shop/contracts/catalog/catalog.product.admin.contract';
import {
  adminProductListItemExample,
  type AdminProductListItem,
} from '@shop/contracts/catalog/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { ProductSelect } from './product-select';

/**
 * 商品 picked by name. What matters: an id already in the form is shown by its
 * name, a search finds by name or by a pasted id, and what goes back into the
 * form is the id string — never the label, never a number.
 */

const coffee: AdminProductListItem = { ...adminProductListItemExample, id: '12', name: '挂耳咖啡' };
const tea: AdminProductListItem = { ...adminProductListItemExample, id: '13', name: '明前龙井' };
const catalog = [coffee, tea];

const reader = { ...testIdentity, permissions: ['catalog:product:read'] };

function stubApi(): StubCall[] {
  return stubRoutes([
    on(catalogAdminProductList, (call) => {
      const ids = call.query.get('ids')?.split(',');
      const keyword = call.query.get('keyword');
      const items = catalog.filter(
        (item) =>
          (ids === undefined || ids.includes(item.id)) &&
          (keyword === null || item.name.includes(keyword)),
      );
      return { items, total: items.length, page: 1, pageSize: 20 };
    }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

describe('<ProductSelect>', () => {
  it('names the product already chosen', async () => {
    stubApi();
    renderAdmin(<ProductSelect value="13" />, { identity: reader });
    expect(await screen.findByText('明前龙井（#13）')).toBeInTheDocument();
  });

  it('finds a product by name and hands back its id', async () => {
    stubApi();
    const onChange = vi.fn();
    renderAdmin(<ProductSelect onChange={onChange} />, { identity: reader });

    await userEvent.type(screen.getByRole('combobox'), '咖啡');
    await userEvent.click(await screen.findByTitle('挂耳咖啡（#12）'));
    expect(onChange).toHaveBeenCalledWith('12');
  });

  it('finds a product by a pasted id', async () => {
    const calls = stubApi();
    renderAdmin(<ProductSelect />, { identity: reader });

    await userEvent.type(screen.getByRole('combobox'), '13');
    expect(await screen.findByTitle('明前龙井（#13）')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.query.get('ids') === '13')).toBe(true));
  });

  it('keeps several ids with `multiple`', async () => {
    stubApi();
    const onChange = vi.fn();
    renderAdmin(<ProductSelect multiple value={['12']} onChange={onChange} />, {
      identity: reader,
    });

    expect(await screen.findByText('挂耳咖啡（#12）')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox'), '龙井');
    await userEvent.click(await screen.findByTitle('明前龙井（#13）'));
    expect(onChange).toHaveBeenCalledWith(['12', '13']);
  });

  it('is the plain id box for a role that may not read products', () => {
    const calls = stubApi();
    renderAdmin(<ProductSelect value="12" />, { identity: testIdentity });
    expect(screen.getByDisplayValue('12')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
