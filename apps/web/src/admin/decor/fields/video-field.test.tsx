import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AssetSourceProvider } from '@/admin/kit/asset/asset-source-context';
import type { AssetItem, AssetSource } from '@/admin/kit/asset/types';
import { createStubAssetSource } from '@/test/asset-source';
import { renderAdmin } from '@/test/render';

import { isPlayableVideo, VideoField } from './basic';

// The field runs inside Puck; here only its label wrapper is needed.
vi.mock('@puckeditor/core', () => ({
  FieldLabel: ({ label, children }: { label: string; children: ReactNode }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
}));

const CLIP: AssetItem = {
  id: 'v1',
  url: 'https://cdn.example.com/intro.mp4',
  name: '品牌介绍.mp4',
  mime: 'video/mp4',
  size: 2_400_000,
};

const PHOTO: AssetItem = {
  id: 'p1',
  url: 'https://cdn.example.com/cover.png',
  name: '封面.png',
  mime: 'image/png',
  size: 12_000,
};

/** A library holding one video and one picture. */
function library(): AssetSource {
  const stub = createStubAssetSource(0);
  return {
    ...stub,
    listAssets: async (query) => ({
      items: [CLIP, PHOTO],
      total: 2,
      page: query.page,
      pageSize: query.pageSize,
    }),
  };
}

function Harness({
  initial,
  optional = false,
  onValue,
}: {
  initial?: string;
  optional?: boolean;
  onValue: (next: string | undefined) => void;
}) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <AssetSourceProvider source={library()}>
      <VideoField
        field={{
          type: 'custom',
          label: '视频（mp4）',
          render: () => null as never,
          metadata: { meta: undefined, optional },
        }}
        name="src"
        id="src"
        value={value}
        onChange={(next: string | undefined) => {
          setValue(next);
          onValue(next);
        }}
      />
    </AssetSourceProvider>
  );
}

async function pick(item: AssetItem) {
  fireEvent.click(screen.getByRole('button', { name: /选择视频|更换视频/ }));
  fireEvent.click(await screen.findByTestId(`asset-${item.id}`));
  fireEvent.click(screen.getByRole('button', { name: /确定/ }));
}

describe('the video field', () => {
  it('knows the videos the mini-program can play', () => {
    expect(isPlayableVideo(CLIP)).toBe(true);
    expect(isPlayableVideo({ mime: 'video/quicktime' })).toBe(true);
    expect(isPlayableVideo(PHOTO)).toBe(false);
    expect(isPlayableVideo({ mime: 'video/webm' })).toBe(false);
  });

  it('stores the picked video’s address and previews it without playing', async () => {
    const onValue = vi.fn();
    renderAdmin(<Harness onValue={onValue} />);
    expect(screen.queryByTestId('video-field-preview')).toBeNull();

    await pick(CLIP);
    await waitFor(() => expect(onValue).toHaveBeenLastCalledWith(CLIP.url));
    const preview = screen.getByTestId('video-field-preview') as HTMLVideoElement;
    expect(preview.getAttribute('src')).toBe(CLIP.url);
    expect(preview.muted).toBe(true);
    expect(preview.autoplay).toBe(false);
    expect(preview.getAttribute('preload')).toBe('metadata');
  });

  it('refuses a picture picked from the library, keeping the video it had', async () => {
    const onValue = vi.fn();
    renderAdmin(<Harness initial={CLIP.url} onValue={onValue} />);

    await pick(PHOTO);
    expect(await screen.findByText('「封面.png」不是 mp4 视频，请另选')).toBeInTheDocument();
    expect(onValue).not.toHaveBeenCalled();
    expect(screen.getByTestId('video-field-preview').getAttribute('src')).toBe(CLIP.url);
  });

  it('draws the library’s videos as video frames, not broken pictures', async () => {
    renderAdmin(<Harness onValue={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '选择视频' }));
    const tile = await screen.findByTestId(`asset-${CLIP.id}`);
    expect(tile.querySelector('video')).not.toBeNull();
    expect(tile.querySelector('img')).toBeNull();
    expect(screen.getByTestId(`asset-${PHOTO.id}`).querySelector('img')).not.toBeNull();
  });

  it('takes a pasted address, and clears only when the value may be empty', () => {
    const onValue = vi.fn();
    const { unmount } = renderAdmin(<Harness initial={CLIP.url} onValue={onValue} />);
    expect(screen.queryByRole('button', { name: '清除' })).toBeNull();
    fireEvent.change(screen.getByLabelText('视频（mp4）地址'), {
      target: { value: ' /uploads/a.mp4 ' },
    });
    expect(onValue).toHaveBeenLastCalledWith('/uploads/a.mp4');
    unmount();

    const cleared = vi.fn();
    renderAdmin(<Harness initial={CLIP.url} optional onValue={cleared} />);
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(cleared).toHaveBeenLastCalledWith(undefined);
  });
});
