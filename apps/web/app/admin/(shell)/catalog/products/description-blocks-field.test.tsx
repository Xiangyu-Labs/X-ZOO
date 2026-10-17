import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DescriptionBlockInput } from '@shop/contracts/catalog/description';

import { withStubAssets } from '@/test/asset-source';
import { renderAdmin } from '@/test/render';

import { DescriptionBlocksField, insertBlock } from './description-blocks-field';

// The editor is ProseMirror behind next/dynamic; a textarea stands in.
vi.mock('@/admin/kit/form/rich-text-field', () => ({
  RichTextField: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <textarea aria-label="富文本内容" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

const TEXT: DescriptionBlockInput = { id: 't1', type: 'richText', html: '<p>面料</p>' };
const CLIP: DescriptionBlockInput = { id: 'v1', type: 'video', src: '/uploads/fit.mp4' };

function Harness({
  initial,
  seen,
}: {
  initial: DescriptionBlockInput[];
  seen: DescriptionBlockInput[][];
}) {
  const [value, setValue] = useState(initial);
  return withStubAssets(
    <DescriptionBlocksField
      value={value}
      onChange={(next) => {
        seen.push(next);
        setValue(next);
      }}
    />,
  );
}

const kinds = () =>
  screen
    .getAllByTestId('description-block')
    .map((card) => within(card).getByText(/第 \d 个/).textContent);

describe('商品详情组件', () => {
  it('puts a new block after the selected one, or at the end', () => {
    const extra: DescriptionBlockInput = { id: 'x', type: 'richText', html: '' };
    expect(insertBlock([TEXT, CLIP], extra, 0).map((b) => b.id)).toEqual(['t1', 'x', 'v1']);
    expect(insertBlock([TEXT, CLIP], extra, -1).map((b) => b.id)).toEqual(['t1', 'v1', 'x']);
  });

  it('adds a video after the selected block, moves it, and plays it', async () => {
    const seen: DescriptionBlockInput[][] = [];
    renderAdmin(<Harness initial={[TEXT, CLIP]} seen={seen} />);

    // Select the first block, then add: the video lands second.
    fireEvent.click(screen.getAllByTestId('description-block')[0]!);
    fireEvent.click(screen.getByRole('button', { name: /添加视频/ }));
    expect(kinds()).toEqual(['富文本 · 第 1 个', '视频 · 第 2 个', '视频 · 第 3 个']);
    expect(seen.at(-1)?.[1]).toMatchObject({ type: 'video', src: '' });
    expect(screen.getByText('请选择视频')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '上移视频 · 第 3 个' }));
    expect(
      seen
        .at(-1)
        ?.map((b) => b.id)
        .slice(0, 2),
    ).toEqual(['t1', 'v1']);

    fireEvent.click(screen.getByRole('button', { name: '播放详情视频' }));
    expect(await screen.findByTestId('video-player')).toHaveAttribute('src', '/uploads/fit.mp4');
  });

  it('asks before deleting a block with content, and not for an empty one', async () => {
    const seen: DescriptionBlockInput[][] = [];
    const empty: DescriptionBlockInput = { id: 'e', type: 'richText', html: '' };
    renderAdmin(<Harness initial={[TEXT, empty]} seen={seen} />);

    fireEvent.click(screen.getByRole('button', { name: '删除富文本 · 第 2 个' }));
    expect(seen.at(-1)?.map((b) => b.id)).toEqual(['t1']);

    fireEvent.click(screen.getByRole('button', { name: '删除富文本 · 第 1 个' }));
    expect(seen).toHaveLength(1);
    const confirm = (await screen.findByText('删除这个富文本？')).closest('.ant-popover');
    fireEvent.click(within(confirm as HTMLElement).getByRole('button', { name: /删\s*除/ }));
    await waitFor(() => expect(seen.at(-1)).toEqual([]));
  });
});
