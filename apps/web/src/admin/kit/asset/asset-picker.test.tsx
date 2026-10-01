import { fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createStubAssetSource } from '@/test/asset-source';
import { renderAdmin, testIdentity } from '@/test/render';

import { AssetField } from '../form/asset-field';
import { AssetPicker, selectRange } from './asset-picker';
import { AssetSourceProvider, useAssetSource } from './asset-source-context';
import type { AssetItem, AssetSource } from './types';

/**
 * `<AssetPicker>` reads its files from the mounted `AssetSource` and from
 * nothing else. What the operator picks is saved into a record and served to
 * shoppers, so a picker with no source must fail loudly instead of offering
 * files that are not in the library.
 */

describe('AssetPicker', () => {
  it('refuses to render without a mounted asset source', () => {
    expect(() => renderHook(() => useAssetSource())).toThrow(/AssetSourceProvider/);
  });

  it('lists the mounted source’s files', async () => {
    const stub = createStubAssetSource(3);
    const source: AssetSource = { ...stub, listAssets: vi.fn(stub.listAssets) };
    renderAdmin(
      <AssetSourceProvider source={source}>
        <AssetPicker open onClose={() => {}} onSelect={() => {}} />
      </AssetSourceProvider>,
    );

    expect(await screen.findByAltText('示例素材-1.png')).toBeInTheDocument();
    expect(source.listAssets).toHaveBeenCalled();
  });

  it('Shift+click picks the run from the last clicked tile, numbered in sweep order', async () => {
    const onSelect = vi.fn();
    renderAdmin(
      <AssetSourceProvider source={createStubAssetSource(8)}>
        <AssetPicker open multiple onClose={() => {}} onSelect={onSelect} />
      </AssetSourceProvider>,
    );

    fireEvent.click(await screen.findByTestId('asset-5'));
    fireEvent.click(screen.getByTestId('asset-2'), { shiftKey: true });

    expect(screen.getByTestId('asset-5')).toHaveTextContent('1');
    expect(screen.getByTestId('asset-4')).toHaveTextContent('2');
    expect(screen.getByTestId('asset-2')).toHaveTextContent('4');
    expect(screen.getByTestId('asset-1')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
    expect(onSelect.mock.calls[0]?.[0].map((asset: AssetItem) => asset.id)).toEqual([
      '5',
      '4',
      '3',
      '2',
    ]);
  });

  it('shows what the field already holds as 已添加 and steps over it in a run', async () => {
    const onSelect = vi.fn();
    renderAdmin(
      <AssetSourceProvider source={createStubAssetSource(8)}>
        <AssetPicker open multiple taken={['3']} onClose={() => {}} onSelect={onSelect} />
      </AssetSourceProvider>,
    );

    const held = await screen.findByTestId('asset-3');
    expect(held).toHaveTextContent('已添加');
    fireEvent.click(held);
    expect(held).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('asset-1'));
    fireEvent.click(screen.getByTestId('asset-5'), { shiftKey: true });
    expect(screen.getByTestId('asset-4')).toHaveTextContent('3');

    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
    expect(onSelect.mock.calls[0]?.[0].map((asset: AssetItem) => asset.id)).toEqual([
      '1',
      '2',
      '4',
      '5',
    ]);
  });
});

describe('AssetField', () => {
  it('offers again only what it does not hold, and keeps max', async () => {
    const source = createStubAssetSource(6);
    const { items } = await source.listAssets({ page: 1, pageSize: 6 });
    const urls = items.map((item) => item.url);
    const onChange = vi.fn();
    renderAdmin(
      <AssetSourceProvider source={source}>
        <AssetField multiple max={3} value={[urls[1]]} onChange={onChange} />
      </AssetSourceProvider>,
    );

    fireEvent.click(screen.getByTestId('asset-field-add'));
    expect(await screen.findByTestId('asset-2')).toHaveTextContent('已添加');
    fireEvent.click(screen.getByTestId('asset-1'));
    fireEvent.click(screen.getByTestId('asset-4'), { shiftKey: true });

    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
    // Room for two more: 图 2 is held, so the run from 图 1 stops after 图 3.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([urls[1], urls[0], urls[2]]));
  });
});

describe('an admin without the whole material library', () => {
  const permissioned = (): AssetSource => {
    const stub = createStubAssetSource(3);
    return {
      ...stub,
      permissions: {
        list: 'storage:attachment:read',
        upload: 'storage:attachment:write',
        categories: 'storage:category:read',
      },
      listCategories: vi.fn(stub.listCategories),
    };
  };

  it('browses without folders or upload when it may only read files', async () => {
    const source = permissioned();
    renderAdmin(
      <AssetSourceProvider source={source}>
        <AssetPicker open onClose={() => {}} onSelect={() => {}} />
      </AssetSourceProvider>,
      { identity: { ...testIdentity, permissions: ['storage:attachment:read'] } },
    );

    expect(await screen.findByAltText('示例素材-1.png')).toBeInTheDocument();
    expect(source.listCategories).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /上\s*传/ })).toBeNull();
  });

  it('says there is no library instead of opening a picker of 403s (个人资料 头像)', () => {
    renderAdmin(
      <AssetSourceProvider source={permissioned()}>
        <AssetField />
      </AssetSourceProvider>,
      { identity: { ...testIdentity, permissions: [] } },
    );

    expect(screen.getByTestId('asset-field-no-access')).toHaveTextContent('没有素材库权限');
    expect(screen.queryByTestId('asset-field-add')).toBeNull();
  });
});

describe('selectRange', () => {
  const items: AssetItem[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id,
    url: '',
    name: id,
    mime: 'image/png',
    size: 1,
  }));
  const ids = (list: AssetItem[]) => list.map((item) => item.id);

  it('keeps what is already picked and appends the rest of the run', () => {
    const { next } = selectRange([items[2]!], items, 'a', 3, undefined);
    expect(ids(next)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('picks only the clicked tile when the anchor is not on this page', () => {
    expect(ids(selectRange([], items, 'zz', 2, undefined).next)).toEqual(['c']);
    expect(ids(selectRange([], items, null, 2, undefined).next)).toEqual(['c']);
  });

  it('steps over what the field already holds', () => {
    const { next } = selectRange([], items, 'e', 0, undefined, (item) => item.id === 'c');
    expect(ids(next)).toEqual(['e', 'd', 'b', 'a']);
  });

  it('stops at max and says so', () => {
    const result = selectRange([], items, 'a', 4, 3);
    expect(ids(result.next)).toEqual(['a', 'b', 'c']);
    expect(result.capped).toBe(true);
  });
});
