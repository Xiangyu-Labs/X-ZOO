import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderAdmin } from '@/test/render';

import { SideTree } from './side-tree';

const LONG = '6975488695540';

describe('SideTree', () => {
  it('shows a long title whole and lets the pane scroll sideways', () => {
    const { container } = renderAdmin(
      <SideTree
        defaultExpandAll
        treeData={[{ key: 'a', title: '商品图', children: [{ key: 'b', title: LONG }] }]}
      />,
    );

    const title = screen.getByText(LONG);
    expect(title).toHaveAttribute('title', LONG);
    expect(title).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(container.firstElementChild).toHaveStyle({ overflowX: 'auto' });
  });
});
