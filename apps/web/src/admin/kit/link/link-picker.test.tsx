import { renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createStubLinkSource } from '@/test/link-source';
import { renderAdmin, zhName } from '@/test/render';

import { LinkPicker, LinkSourceProvider, useLinkSource } from './link-picker';
import type { LinkSource } from './types';

/**
 * `<LinkPicker>` reads its rows from the mounted `LinkSource` and from nothing
 * else. What the operator picks is saved and opened by the storefront, so a
 * picker with no source must fail loudly instead of offering links that are
 * not in the shop.
 */

describe('LinkPicker', () => {
  it('refuses to render without a mounted link source', () => {
    expect(() => renderHook(() => useLinkSource())).toThrow(/LinkSourceProvider/);
  });

  it('offers the mounted source’s rows and hands back the picked link', async () => {
    const user = userEvent.setup();
    const stub = createStubLinkSource();
    const source: LinkSource = {
      listPages: vi.fn(stub.listPages),
      listTargets: vi.fn(stub.listTargets),
    };
    const onSelect = vi.fn();
    renderAdmin(
      <LinkSourceProvider source={source}>
        <LinkPicker open onClose={() => {}} onSelect={onSelect} allow={['category', 'page']} />
      </LinkSourceProvider>,
    );

    const modal = await screen.findByRole('dialog');
    const first = await within(modal).findAllByRole('button', { name: zhName('选择') });
    await user.click(first[0]!);

    expect(source.listTargets).toHaveBeenCalledWith('category', {
      keyword: '',
      page: 1,
      pageSize: 10,
    });
    expect(onSelect).toHaveBeenCalledWith({
      type: 'category',
      label: expect.stringContaining('分类'),
      url: '/pages/goods/goods_list/index?cid=1',
    });
  });
});
