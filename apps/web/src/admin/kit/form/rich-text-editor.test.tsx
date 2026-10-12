import Image from '@tiptap/extension-image';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStubAssetSource } from '@/test/asset-source';
import { renderAdmin } from '@/test/render';

import { AssetSourceProvider } from '../asset/asset-source-context';
import type { AssetItem } from '../asset/types';
import RichTextEditor, {
  insertImagesAfter,
  moveSelectedImage,
  selectedImage,
} from './rich-text-editor';

/**
 * 商品详情 is mostly a column of pictures, so the editor has to take several at once in the
 * order they were picked, and let the operator reorder, add below and remove one.
 */

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function editorWith(html: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, Image.configure({ inline: false })],
    content: html,
  });
  editors.push(editor);
  return editor;
}

/** The `src` of each picture in document order. */
function pictures(editor: Editor): string[] {
  const out: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') out.push(String(node.attrs['src']));
  });
  return out;
}

/** Select the n-th top-level block (a picture), as a click on it does. */
function selectBlock(editor: Editor, index: number): void {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  editor.commands.setNodeSelection(pos);
}

const asset = (n: number): AssetItem => ({
  id: String(n),
  url: `/uploads/x/${n}.png`,
  name: `图${n}`,
  mime: 'image/png',
  size: 1,
});

describe('RichTextEditor', () => {
  it('inserts every picked picture, in pick order', async () => {
    const onChange = vi.fn();
    renderAdmin(
      <AssetSourceProvider source={createStubAssetSource(6)}>
        <RichTextEditor value="<p>开头</p>" onChange={onChange} />
      </AssetSourceProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '插入图片' }));
    fireEvent.click(await screen.findByTestId('asset-3'));
    fireEvent.click(screen.getByTestId('asset-1'));
    fireEvent.click(screen.getByTestId('asset-2'));
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const html = String(onChange.mock.calls.at(-1)?.[0]);
    const alts = [...html.matchAll(/alt="([^"]+)"/g)].map((match) => match[1]);
    expect(alts).toEqual(['示例素材-3.png', '示例素材-1.png', '示例素材-2.png']);
  });
});

describe('picture tools', () => {
  const html = '<img src="a"><img src="b"><img src="c">';

  it('reports the selected picture and whether it can move', () => {
    expect(selectedImage(editorWith('<p>文字</p>'))).toBeNull();
    const editor = editorWith(html);
    selectBlock(editor, 0);
    expect(selectedImage(editor)).toMatchObject({ before: null });
    selectBlock(editor, 2);
    expect(selectedImage(editor)).toMatchObject({ after: null });
  });

  it('moves a picture down and up, keeping it selected', () => {
    const editor = editorWith(html);
    selectBlock(editor, 0);
    expect(moveSelectedImage(editor, 'down')).toBe(true);
    expect(pictures(editor)).toEqual(['b', 'a', 'c']);
    expect(moveSelectedImage(editor, 'down')).toBe(true);
    expect(pictures(editor)).toEqual(['b', 'c', 'a']);
    expect(moveSelectedImage(editor, 'down')).toBe(false);
    expect(moveSelectedImage(editor, 'up')).toBe(true);
    expect(pictures(editor)).toEqual(['b', 'a', 'c']);
    expect(selectedImage(editor)).not.toBeNull();
  });

  it('moves a picture past a paragraph', () => {
    const editor = editorWith('<p>说明</p><img src="a">');
    selectBlock(editor, 1);
    moveSelectedImage(editor, 'up');
    expect(editor.getHTML()).toMatch(/^<img src="a"[^>]*><p>说明<\/p>/);
  });

  it('inserts pictures right below the selected one', () => {
    const editor = editorWith(html);
    selectBlock(editor, 0);
    insertImagesAfter(editor, [asset(1), asset(2)]);
    expect(pictures(editor)).toEqual(['a', '/uploads/x/1.png', '/uploads/x/2.png', 'b', 'c']);
  });

  it('removes the selected picture and undo brings it back', () => {
    const editor = editorWith(html);
    selectBlock(editor, 1);
    editor.chain().deleteSelection().run();
    expect(pictures(editor)).toEqual(['a', 'c']);
    editor.chain().undo().run();
    expect(pictures(editor)).toEqual(['a', 'b', 'c']);
  });
});
