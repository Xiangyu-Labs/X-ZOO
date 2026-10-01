import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemPermissionTree } from '@shop/contracts/system/system.role.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes } from '@/test/api';
import { renderAdmin } from '@/test/render';

import { PermissionPicker } from './permission-picker';

/**
 * The role editor's checkboxes, against the one rule the server adds on save:
 * an editor atom brings the reads its editor makes. The screen must show that,
 * not let an operator untick something the save would put straight back.
 */

const tree = {
  sections: [
    {
      section: '商品',
      items: [
        { atom: 'catalog:category:read', label: '查看商品分类', domain: 'catalog', requires: [] },
        {
          atom: 'catalog:product:write',
          label: '新建/编辑商品，上下架',
          domain: 'catalog',
          requires: ['catalog:category:read'],
        },
      ],
    },
  ],
  implicit: [],
};

afterEach(() => {
  resetApiConfig();
});

describe('PermissionPicker', () => {
  it('ticks what an editor atom needs along with it', async () => {
    stubRoutes([on(systemPermissionTree, tree)]);
    const onChange = vi.fn();
    renderAdmin(<PermissionPicker value={[]} onChange={onChange} />);

    await userEvent.click(await screen.findByLabelText('新建/编辑商品，上下架'));
    expect([...onChange.mock.calls[0]![0]].sort()).toEqual([
      'catalog:category:read',
      'catalog:product:write',
    ]);
  });

  it('will not untick a read while the editor that needs it is ticked, and says why', async () => {
    stubRoutes([on(systemPermissionTree, tree)]);
    renderAdmin(
      <PermissionPicker
        value={['catalog:product:write', 'catalog:category:read']}
        onChange={vi.fn()}
      />,
    );

    const read = await screen.findByRole('checkbox', { name: /查看商品分类/ });
    expect(read).toBeChecked();
    expect(read).toBeDisabled();
    expect(screen.getByText(/新建\/编辑商品，上下架需要/)).toBeInTheDocument();
  });
});
