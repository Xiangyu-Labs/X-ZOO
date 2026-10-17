import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createStubAssetSource } from '@/test/asset-source';
import { renderAdmin } from '@/test/render';

import { AssetSourceProvider } from '../asset/asset-source-context';
import { AssetField, reorderAssets } from './asset-field';

const PICTURES = ['/uploads/a.png', '/uploads/b.png', '/uploads/c.png'];

describe('AssetField — pictures dragged into order', () => {
  it('moves a picture to where it was dropped, and nothing else', () => {
    expect(reorderAssets(PICTURES, 2, 0)).toEqual([
      '/uploads/c.png',
      '/uploads/a.png',
      '/uploads/b.png',
    ]);
    expect(reorderAssets(PICTURES, 0, 1)).toEqual([
      '/uploads/b.png',
      '/uploads/a.png',
      '/uploads/c.png',
    ]);
    // Dropped where it started, or somewhere that is not a tile: unchanged.
    expect(reorderAssets(PICTURES, 1, 1)).toEqual(PICTURES);
    expect(reorderAssets(PICTURES, 0, 7)).toEqual(PICTURES);
    expect(reorderAssets(PICTURES, Number.NaN, 1)).toEqual(PICTURES);
  });

  it('lets the pictures of a multiple field be dragged, and a single picture not', () => {
    const { unmount } = renderAdmin(
      <AssetSourceProvider source={createStubAssetSource(3)}>
        <AssetField multiple value={PICTURES} onChange={() => {}} />
      </AssetSourceProvider>,
    );
    const tiles = screen.getAllByTestId('asset-field-tile');
    expect(tiles).toHaveLength(3);
    for (const tile of tiles) {
      expect(tile).toHaveAttribute('aria-roledescription', 'sortable');
      expect(tile).toHaveAttribute('title', '拖动调整顺序');
    }
    unmount();

    renderAdmin(
      <AssetSourceProvider source={createStubAssetSource(3)}>
        <AssetField value={PICTURES[0]} onChange={() => {}} />
      </AssetSourceProvider>,
    );
    expect(screen.getByTestId('asset-field-tile')).not.toHaveAttribute('aria-roledescription');
  });
});
