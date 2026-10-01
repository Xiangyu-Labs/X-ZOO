import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  catalogAdminProductDetail,
  catalogAdminVirtualCardImport,
  catalogAdminVirtualCardList,
  catalogAdminVirtualCardVoid,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import {
  adminProductDetailExample,
  productSkuExample,
  type AdminProductDetail,
  type ProductVirtualCard,
} from '@shop/contracts/catalog/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity, zhName } from '@/test/render';

import { VirtualCardsPage, parseCards } from './virtual-cards';

const card: ProductVirtualCard = {
  id: '7001',
  skuId: '1100',
  specText: '面值 50',
  cardKey: 'ck_9f2a',
  cardNo: '8800-1234-5678',
  cardSecret: '9f2a',
  state: 'unclaimed',
  orderItemId: null,
  claimedByUserId: null,
  claimedAt: null,
  createdAt: '2026-06-01T10:00:00+08:00',
};

const product: AdminProductDetail = {
  ...adminProductDetailExample,
  id: '9',
  name: '话费充值卡',
  kind: 'virtual_card',
  specs: [],
  skus: [{ ...productSkuExample, id: '1100', specText: '面值 50', specValues: {} }],
};

function stubApi(): StubCall[] {
  return stubRoutes([
    on(catalogAdminVirtualCardList, { items: [card], total: 1, page: 1, pageSize: 20 }),
    on(catalogAdminVirtualCardVoid, { voided: 1, stock: 1 }),
    on(catalogAdminVirtualCardImport, { imported: 2, skippedCardNos: [], stock: 2 }),
    on(catalogAdminProductDetail, product),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const cardAdmin = {
  ...testIdentity,
  permissions: ['catalog:product:read', 'catalog:card:read', 'catalog:card:write'],
};

describe('卡密库存', () => {
  it('parses a pasted batch, one card per line', () => {
    expect(parseCards('8800-1,9f2a\n8800-2，7b1c\n\n8800-3\t  \n')).toEqual([
      { cardNo: '8800-1', cardSecret: '9f2a' },
      // A full-width comma is what a Chinese spreadsheet exports.
      { cardNo: '8800-2', cardSecret: '7b1c' },
      // No secret is legal: some suppliers ship the number alone.
      { cardNo: '8800-3' },
    ]);
  });

  it('lists the pool for one product', async () => {
    const calls = stubApi();
    renderAdmin(<VirtualCardsPage productId="9" />, { identity: cardAdmin });

    expect(await screen.findByText('8800-1234-5678')).toBeInTheDocument();
    expect(screen.getByText('未发放')).toBeInTheDocument();
    const list = calls.find((call) => call.url.includes('/products/9/virtual-cards'));
    expect(list?.method).toBe('GET');
  });

  it('hides the import and the void button from a reader', async () => {
    stubApi();
    renderAdmin(<VirtualCardsPage productId="9" />, {
      identity: { ...testIdentity, permissions: ['catalog:product:read', 'catalog:card:read'] },
    });

    await screen.findByText('8800-1234-5678');
    expect(screen.queryByRole('button', { name: zhName('导入卡密') })).not.toBeInTheDocument();
  });

  it('asks before voiding a batch, saying how many cards go', async () => {
    const calls = stubApi();
    renderAdmin(<VirtualCardsPage productId="9" />, { identity: cardAdmin });
    await screen.findByText('8800-1234-5678');

    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[checkboxes.length - 1]!);
    await userEvent.click(await screen.findByRole('button', { name: zhName('批量作废') }));

    const ask = await screen.findByText('作废选中的 1 条未发放卡密？');
    expect(calls.some((call) => call.url.includes('/void'))).toBe(false);
    const popup = ask.closest('.ant-popover') as HTMLElement;
    await userEvent.click(within(popup).getByRole('button', { name: zhName('作废') }));

    await waitFor(() => {
      const voided = calls.find((call) => call.method === 'POST' && call.url.includes('void'));
      expect(voided?.body).toEqual({ cardIds: ['7001'] });
    });
  });

  it('imports a pasted batch against the chosen SKU', async () => {
    const calls = stubApi();
    renderAdmin(<VirtualCardsPage productId="9" />, { identity: cardAdmin });
    await screen.findByText('8800-1234-5678');

    await userEvent.click(screen.getByRole('button', { name: zhName('导入卡密') }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), '8800-9001,aaa{enter}8800-9002,bbb');
    await userEvent.click(within(dialog).getByRole('button', { name: zhName('导入') }));

    await waitFor(() => {
      const upload = calls.find((call) => call.method === 'POST');
      expect(upload?.url).toContain('/products/9/virtual-cards');
      expect(upload?.body).toEqual({
        skuId: '1100',
        cards: [
          { cardNo: '8800-9001', cardSecret: 'aaa' },
          { cardNo: '8800-9002', cardSecret: 'bbb' },
        ],
      });
    });
  });
});
