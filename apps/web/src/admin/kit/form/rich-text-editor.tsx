'use client';

import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BoldOutlined,
  DeleteOutlined,
  ItalicOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PictureOutlined,
  PlusOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  UndoOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import Image from '@tiptap/extension-image';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Button, Divider, Space, Tooltip } from 'antd';
import { useEffect, type ReactNode } from 'react';

import { useAssetPicker } from '../asset/asset-picker';
import type { AssetItem } from '../asset/types';

export interface RichTextEditorProps {
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  /** Editing area height in px. Default 280. */
  minHeight?: number | undefined;
}

/**
 * The actual Tiptap editor. Always reached through `<RichTextField>`, which
 * lazy-loads this module — ProseMirror is ~200 kB and most admin pages never
 * open a rich-text field.
 *
 * Image insertion goes through `<AssetPicker>`; there is no direct upload
 * button and no way to paste an arbitrary remote URL into an `<img>` via the
 * toolbar, which keeps every image in the material library.
 */
export default function RichTextEditor({
  value,
  onChange,
  disabled = false,
  minHeight = 280,
}: RichTextEditorProps) {
  const picker = useAssetPicker();

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [StarterKit, Image.configure({ inline: false })],
    content: value ?? '',
    onUpdate: ({ editor: instance }) => onChange?.(instance.getHTML()),
    editorProps: {
      attributes: { class: 'kit-rich-text', style: `min-height:${minHeight}px` },
    },
  });

  // Adopt externally set content (form reset, record loaded) without stomping
  // on what the operator is typing.
  useEffect(() => {
    if (!editor) return;
    const next = value ?? '';
    if (next !== editor.getHTML()) editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor) return null;

  // One insert for the whole pick: chained `setImage` calls replace each other, because each
  // insert leaves the picture it just added selected and the next one lands on top of it.
  const insertImage = async (): Promise<void> => {
    const picked = await picker.pick({ multiple: true });
    if (picked.length === 0) return;
    editor.chain().focus().insertContent(imageNodes(picked)).run();
  };

  const setLink = (): void => {
    const previous = editor.getAttributes('link')['href'] as string | undefined;
    const href = window.prompt('链接地址', previous ?? 'https://');
    if (href === null) return;
    if (href === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };

  return (
    <div
      style={{
        border: '1px solid var(--ant-color-border)',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: 6,
          borderBottom: '1px solid var(--ant-color-border-secondary)',
          background: 'var(--ant-color-fill-quaternary)',
        }}
      >
        <Space size={2} wrap>
          <ToolbarButton
            editor={editor}
            active="bold"
            title="加粗"
            icon={<BoldOutlined />}
            onClick={() => editor.chain().focus().toggleBold().run()}
            disabled={disabled}
          />
          <ToolbarButton
            editor={editor}
            active="italic"
            title="斜体"
            icon={<ItalicOutlined />}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            disabled={disabled}
          />
          <ToolbarButton
            editor={editor}
            active="strike"
            title="删除线"
            icon={<StrikethroughOutlined />}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            disabled={disabled}
          />
          <Divider type="vertical" />
          <ToolbarButton
            editor={editor}
            active="bulletList"
            title="无序列表"
            icon={<UnorderedListOutlined />}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            disabled={disabled}
          />
          <ToolbarButton
            editor={editor}
            active="orderedList"
            title="有序列表"
            icon={<OrderedListOutlined />}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            disabled={disabled}
          />
          <Divider type="vertical" />
          <ToolbarButton
            editor={editor}
            active="link"
            title="链接"
            icon={<LinkOutlined />}
            onClick={setLink}
            disabled={disabled}
          />
          <Tooltip title="插入图片">
            <Button
              size="small"
              type="text"
              icon={<PictureOutlined />}
              aria-label="插入图片"
              disabled={disabled}
              onClick={() => insertImage()}
            />
          </Tooltip>
          <Divider type="vertical" />
          <Tooltip title="撤销">
            <Button
              size="small"
              type="text"
              icon={<UndoOutlined />}
              disabled={disabled}
              onClick={() => editor.chain().focus().undo().run()}
            />
          </Tooltip>
          <Tooltip title="重做">
            <Button
              size="small"
              type="text"
              icon={<RedoOutlined />}
              disabled={disabled}
              onClick={() => editor.chain().focus().redo().run()}
            />
          </Tooltip>
        </Space>
      </div>

      <div style={{ padding: 12, position: 'relative' }}>
        <EditorContent editor={editor} />
        {disabled ? null : (
          <ImageTools editor={editor} pick={() => picker.pick({ multiple: true })} />
        )}
      </div>

      {picker.holder}

      <style>{`
        .kit-rich-text { outline: none; }
        .kit-rich-text img { display: block; max-width: 100%; cursor: pointer; }
        .kit-rich-text img.ProseMirror-selectednode {
          outline: 3px solid var(--ant-color-primary);
          outline-offset: 2px;
        }
        .kit-rich-text p { margin: 0 0 8px; }
      `}</style>
    </div>
  );
}

function imageNodes(assets: readonly AssetItem[]) {
  return assets.map((asset) => ({ type: 'image', attrs: { src: asset.url, alt: asset.name } }));
}

interface SelectedImage {
  pos: number;
  size: number;
  /** The blocks before and after it in the same parent, for 上移 / 下移. */
  before: number | null;
  after: number | null;
}

/** The picture the operator clicked (a node selection on an image), or null. */
export function selectedImage(editor: Editor): SelectedImage | null {
  const { selection } = editor.state;
  const node = 'node' in selection ? (selection.node as typeof editor.state.doc | undefined) : null;
  if (!node || node.type.name !== 'image') return null;
  const $pos = editor.state.doc.resolve(selection.from);
  const index = $pos.index();
  const parent = $pos.parent;
  const next = index < parent.childCount - 1 ? parent.child(index + 1) : null;
  // The empty paragraph the editor keeps after a last picture is a place to type, not a block
  // to move past.
  const trailing = next !== null && index + 1 === parent.childCount - 1 && next.content.size === 0;
  return {
    pos: selection.from,
    size: node.nodeSize,
    before: index > 0 ? parent.child(index - 1).nodeSize : null,
    after: next && !trailing ? next.nodeSize : null,
  };
}

/**
 * Swap the selected picture with the block above or below it, as one undoable step, and keep
 * it selected so the button can be pressed again. False when there is nothing to swap with.
 */
export function moveSelectedImage(editor: Editor, direction: 'up' | 'down'): boolean {
  const image = selectedImage(editor);
  const neighbour = direction === 'up' ? image?.before : image?.after;
  if (!image || neighbour == null) return false;
  const node = editor.state.doc.nodeAt(image.pos);
  if (!node) return false;
  // Positions after the picture is taken out: the block below now starts where it was.
  const to = direction === 'up' ? image.pos - neighbour : image.pos + neighbour;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.delete(image.pos, image.pos + image.size);
      tr.insert(to, node);
      return true;
    })
    .setNodeSelection(to)
    .run();
}

/** Put `assets` right below the selected picture, in pick order. */
export function insertImagesAfter(editor: Editor, assets: readonly AssetItem[]): boolean {
  const image = selectedImage(editor);
  if (!image) return false;
  return editor
    .chain()
    .focus()
    .insertContentAt(image.pos + image.size, imageNodes(assets))
    .run();
}

/**
 * The bar over a selected picture: move it up or down past its neighbour, add pictures right
 * below it, or remove it. Every action is one undoable step and keeps the moved picture
 * selected, so 上移 can be pressed again.
 */
function ImageTools({ editor, pick }: { editor: Editor; pick: () => Promise<AssetItem[]> }) {
  // Read where the picture sits in the same pass: `transaction` fires after the view has drawn it.
  const image = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const selected = selectedImage(e);
      if (!selected) return null;
      const dom = e.view.nodeDOM(selected.pos);
      const place =
        dom instanceof HTMLElement ? { top: dom.offsetTop, left: dom.offsetLeft } : null;
      return { ...selected, place };
    },
  });

  if (!image) return null;

  const insertBelow = async (): Promise<void> => {
    const picked = await pick();
    if (picked.length > 0) insertImagesAfter(editor, picked);
  };

  return (
    <div
      role="toolbar"
      aria-label="图片操作"
      style={{
        position: 'absolute',
        top: (image.place?.top ?? 0) + 8,
        left: (image.place?.left ?? 0) + 8,
        padding: 2,
        borderRadius: 6,
        background: 'var(--ant-color-bg-elevated)',
        boxShadow: 'var(--ant-box-shadow-secondary)',
        zIndex: 1,
      }}
      // Keep the picture selected while the bar is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Space size={2}>
        <Tooltip title="上移">
          <Button
            size="small"
            type="text"
            icon={<ArrowUpOutlined />}
            aria-label="上移图片"
            disabled={image.before === null}
            onClick={() => moveSelectedImage(editor, 'up')}
          />
        </Tooltip>
        <Tooltip title="下移">
          <Button
            size="small"
            type="text"
            icon={<ArrowDownOutlined />}
            aria-label="下移图片"
            disabled={image.after === null}
            onClick={() => moveSelectedImage(editor, 'down')}
          />
        </Tooltip>
        <Tooltip title="在下方插入图片">
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            aria-label="在下方插入图片"
            onClick={() => insertBelow()}
          />
        </Tooltip>
        <Tooltip title="删除图片">
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label="删除图片"
            onClick={() => editor.chain().focus().deleteSelection().run()}
          />
        </Tooltip>
      </Space>
    </div>
  );
}

function ToolbarButton({
  editor,
  active,
  title,
  icon,
  onClick,
  disabled,
}: {
  editor: Editor;
  active: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Tooltip title={title}>
      <Button
        size="small"
        type={editor.isActive(active) ? 'primary' : 'text'}
        icon={icon}
        disabled={disabled}
        onClick={onClick}
      />
    </Tooltip>
  );
}
