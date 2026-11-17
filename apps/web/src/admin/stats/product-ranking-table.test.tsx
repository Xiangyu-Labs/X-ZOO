import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { statsProductRanking } from '@shop/contracts/stats/stats.admin.contract';
import { productRankingExample } from '@shop/contracts/stats/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin } from '@/test/render';

import { ProductRankingTable } from './product-ranking-table';

/**
 * The export beside the ranking downloads what the table is showing. A
 * hard-coded `sortBy: 'paidAmount'` used to export a different set of products
 * from the one on screen as soon as the operator changed the sort.
 */
describe('<ProductRankingTable>', () => {
  afterEach(() => resetApiConfig());

  it('hands its own sort and limit to the actions it renders', async () => {
    stubRoutes([on(statsProductRanking, productRankingExample)]);
    const user = userEvent.setup();
    renderAdmin(
      <ProductRankingTable
        query={{}}
        extra={({ sortBy, limit }) => (
          <span data-testid="export-query">{`${sortBy}:${limit}`}</span>
        )}
      />,
    );

    expect(screen.getByTestId('export-query')).toHaveTextContent('paidAmount:20');

    await user.click(screen.getAllByRole('combobox')[0]!);
    await user.click(await screen.findByTitle('支付件数'));

    await waitFor(() =>
      expect(screen.getByTestId('export-query')).toHaveTextContent('paidQuantity:20'),
    );

    await user.click(screen.getAllByRole('combobox')[1]!);
    await user.click(await screen.findByTitle('前 50 名'));

    await waitFor(() =>
      expect(screen.getByTestId('export-query')).toHaveTextContent('paidQuantity:50'),
    );
  });
});
