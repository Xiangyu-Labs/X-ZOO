import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ShippingTemplateDetail,
  ShippingTemplateListItem,
} from '@shop/contracts/shipping/schemas';
import { cityTreeAdmin } from '@shop/contracts/shipping/shipping.city.contract';
import {
  shippingTemplateDetailRoute,
  shippingTemplateList,
  shippingTemplateTrial,
  shippingTemplateUpdate,
} from '@shop/contracts/shipping/shipping.template.admin.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { ShippingTemplatesPage } from './shipping-templates';

/**
 * 运费模板 as a component test.
 *
 * The wiring worth asserting is that the list comes from the contract route,
 * that 删除 sits on its own `shipping:template:delete` atom (write is not
 * enough — deleting a template silently moves products onto "no template"),
 * and that opening the editor fetches the detail the drawer edits, since the
 * list row carries no rules.
 */

const row: ShippingTemplateListItem = {
  id: '1',
  name: '全国包邮（满 5 件）',
  chargeMode: 'quantity',
  hasFreeRules: true,
  hasNoDeliveryRules: false,
  sortOrder: 10,
  productCount: 4,
  createdAt: '2026-01-01T09:00:00+08:00',
  updatedAt: '2026-06-01T09:00:00+08:00',
};

const detail: ShippingTemplateDetail = {
  ...row,
  regions: [
    {
      isFallback: true,
      cityIds: [],
      firstUnit: 1,
      firstPrice: '10.00',
      additionalUnit: 1,
      additionalPrice: '5.00',
    },
  ],
  freeRules: [{ cityIds: [], minUnits: 5, minAmount: null }],
  noDeliveryCityIds: [],
};

function stubApi(): StubCall[] {
  return stubRoutes([
    on(cityTreeAdmin, {
      items: [{ id: '330000', name: '浙江省', level: 0, children: [] }],
      version: 'test',
    }),
    on(shippingTemplateList, { items: [row], total: 1, page: 1, pageSize: 20 }),
    on(shippingTemplateDetailRoute, detail),
    on(shippingTemplateUpdate, detail),
    on(shippingTemplateTrial, {
      outcome: 'charged',
      fee: '15.00',
      steps: ['收货地区：浙江省', '没有命中任何地区规则，按「默认全国」计算'],
    }),
  ]);
}

afterEach(() => {
  resetApiConfig();
});

const writer = {
  ...testIdentity,
  permissions: ['shipping:template:read', 'shipping:template:write'],
};

describe('运费模板', () => {
  it('lists templates from the contract route', async () => {
    const calls = stubApi();
    renderAdmin(<ShippingTemplatesPage />, { identity: writer });

    expect(await screen.findByText('全国包邮（满 5 件）')).toBeInTheDocument();
    expect(screen.getByText('按件数')).toBeInTheDocument();
    expect(screen.getByText('包邮规则')).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/admin-api/shipping/templates?');
    expect(calls[0]?.url).toContain('page=1');
  });

  it('keeps 删除 on its own atom, which write alone does not grant', async () => {
    stubApi();
    renderAdmin(<ShippingTemplatesPage />, { identity: writer });

    await screen.findByText('全国包邮（满 5 件）');
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
  });

  it('hides the toolbar from a read-only admin', async () => {
    stubApi();
    renderAdmin(<ShippingTemplatesPage />, {
      identity: { ...testIdentity, permissions: ['shipping:template:read'] },
    });

    await screen.findByText('全国包邮（满 5 件）');
    expect(screen.queryByRole('button', { name: /新建模板/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('loads the detail when the drawer opens, because the row carries no rules', async () => {
    const calls = stubApi();
    renderAdmin(<ShippingTemplatesPage />, { identity: writer });
    await screen.findByText('全国包邮（满 5 件）');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('编辑运费模板')).toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/admin-api/shipping/templates/1'))).toBe(true);
  });

  it('prices the template as the drawer holds it, unsaved edits included', async () => {
    const calls = stubApi();
    renderAdmin(<ShippingTemplatesPage />, { identity: writer });
    await screen.findByText('全国包邮（满 5 件）');
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const drawer = await screen.findByRole('dialog');
    const name = await within(drawer).findByLabelText('模板名称');
    await userEvent.clear(name);
    await userEvent.type(name, '改过还没保存');

    await userEvent.click(within(drawer).getByTestId('freight-trial'));
    const modal = (await screen.findAllByRole('dialog')).at(-1)!;
    await userEvent.click(within(modal).getByRole('combobox'));
    await userEvent.click(await screen.findByTitle('浙江省'));
    await userEvent.click(within(modal).getByRole('button', { name: '试 算' }));

    const result = await within(modal).findByTestId('freight-trial-result');
    expect(within(result).getByText('¥15.00')).toBeInTheDocument();
    expect(within(result).getByText(/按「默认全国」计算/)).toBeInTheDocument();
    const trial = calls.find((call) => call.path === '/admin-api/shipping/template-trial');
    expect(trial?.body).toMatchObject({
      template: { name: '改过还没保存', chargeMode: 'quantity' },
      cityId: '330000',
      units: 1,
    });
  });
});
