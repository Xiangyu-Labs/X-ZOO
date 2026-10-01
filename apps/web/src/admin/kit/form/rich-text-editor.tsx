'use client';

import {
  BoldOutlined,
  ItalicOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PictureOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  UndoOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import Image from '@tiptap/extension-image';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Button, Divider, Space, Tooltip } from 'antd';
import { useEffect, type ReactNode } from 'react';

import { useAssetPicker } from '../asset/asset-picker';

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

  const insertImage = async (): Promise<void> => {
    const picked = await picker.pick({ multiple: true });
    if (picked.length === 0) return;
    let chain = editor.chain().focus();
    for (const asset of picked) chain = chain.setImage({ src: asset.url, alt: asset.name });
    chain.run();
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

      <div style={{ padding: 12 }}>
        <EditorContent editor={editor} />
      </div>

      {picker.holder}

      <style>{`
        .kit-rich-text { outline: none; }
        .kit-rich-text img { max-width: 100%; }
        .kit-rich-text p { margin: 0 0 8px; }
      `}</style>
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
