import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { createStubAssetSource } from '@/test/asset-source';
import { renderAdmin } from '@/test/render';

import { AssetSourceProvider } from '../asset/asset-source-context';
import { VideoAssetField } from './video-asset-field';

function Harness({ initial, onValue }: { initial?: string; onValue: (v?: string) => void }) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <VideoAssetField
      value={value}
      label="主图视频"
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

describe('VideoAssetField', () => {
  it('picks an mp4 from the library and plays it from its thumbnail', async () => {
    const source = createStubAssetSource(2);
    const clip = await source.upload(new File(['x'], '开箱.mp4', { type: 'video/mp4' }));
    const values: (string | undefined)[] = [];
    renderAdmin(
      <AssetSourceProvider source={source}>
        <Harness onValue={(v) => values.push(v)} />
      </AssetSourceProvider>,
    );

    fireEvent.click(screen.getByTestId('video-field-add'));
    fireEvent.click(await screen.findByTestId(`asset-${clip.id}`));
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));
    await waitFor(() => expect(values).toEqual([clip.url]));

    fireEvent.click(screen.getByRole('button', { name: '播放主图视频' }));
    expect(await screen.findByTestId('video-player')).toHaveAttribute('src', clip.url);
  });

  it('clears the field with 移除', () => {
    const values: (string | undefined)[] = [];
    renderAdmin(
      <AssetSourceProvider source={createStubAssetSource(1)}>
        <Harness initial="/uploads/clip.mp4" onValue={(v) => values.push(v)} />
      </AssetSourceProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '移除主图视频' }));
    expect(values).toEqual([undefined]);
    expect(screen.getByTestId('video-field-add')).toBeInTheDocument();
  });
});
