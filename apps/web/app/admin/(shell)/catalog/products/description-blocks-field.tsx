'use client';

import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  FileTextOutlined,
  HolderOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Popconfirm, Space, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import {
  DESCRIPTION_BLOCKS_MAX,
  type DescriptionBlockInput,
} from '@shop/contracts/catalog/description';

import { AssetField } from '@/admin/kit/form/asset-field';
import { RichTextField } from '@/admin/kit/form/rich-text-field';
import { VideoAssetField } from '@/admin/kit/form/video-asset-field';

type Block = DescriptionBlockInput;

const KIND_TEXT: Record<Block['type'], string> = { richText: '富文本', video: '视频' };

/** An id no other block of this product has: blocks are told apart by it. */
export function newBlockId(taken: readonly Block[]): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10);
    if (id.length > 0 && !taken.some((block) => block.id === id)) return id;
  }
}

/** Whether removing the block loses something the operator made. */
function hasContent(block: Block): boolean {
  if (block.type === 'video') return block.src.trim() !== '';
  return block.html.replace(/<p>\s*<\/p>/g, '').trim() !== '';
}

/** The blocks with `block` put right after the one at `after` (or at the end). */
export function insertBlock(blocks: readonly Block[], block: Block, after: number): Block[] {
  const at = after < 0 || after >= blocks.length ? blocks.length : after + 1;
  return [...blocks.slice(0, at), block, ...blocks.slice(at)];
}

export interface DescriptionBlocksFieldProps {
  value?: Block[] | undefined;
  onChange?: ((value: Block[]) => void) | undefined;
  disabled?: boolean | undefined;
}

/**
 * 商品详情 as a column of blocks — 富文本 and 视频 — in the order the product
 * page shows them. A click selects a block; it is dragged by its handle or
 * moved with 上移 / 下移; 删除 asks first when the block has content; a new
 * block goes right after the selected one.
 */
export function DescriptionBlocksField({
  value,
  onChange,
  disabled = false,
}: DescriptionBlocksFieldProps) {
  const blocks = value ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const selectedIndex = blocks.findIndex((block) => block.id === selected);
  const full = blocks.length >= DESCRIPTION_BLOCKS_MAX;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const emit = (next: Block[]): void => onChange?.(next);
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= blocks.length) return;
    emit(arrayMove(blocks, from, to));
  };
  const replace = (index: number, block: Block): void =>
    emit(blocks.map((item, i) => (i === index ? block : item)));
  const remove = (index: number): void => {
    emit(blocks.filter((_item, i) => i !== index));
    if (blocks[index]?.id === selected) setSelected(null);
  };
  const add = (type: Block['type']): void => {
    const id = newBlockId(blocks);
    const block: Block = type === 'richText' ? { id, type, html: '' } : { id, type, src: '' };
    emit(insertBlock(blocks, block, selectedIndex));
    setSelected(id);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = blocks.findIndex((block) => block.id === active.id);
    const to = blocks.findIndex((block) => block.id === over.id);
    if (from >= 0 && to >= 0) move(from, to);
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {blocks.length === 0 ? (
        <Typography.Text type="secondary">
          还没有商品详情。用下面的按钮添加富文本或视频，可以添加多个，并调整顺序。
        </Typography.Text>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={blocks.map((block) => block.id)}
          strategy={verticalListSortingStrategy}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {blocks.map((block, index) => (
              <BlockCard
                key={block.id}
                block={block}
                index={index}
                count={blocks.length}
                selected={block.id === selected}
                disabled={disabled}
                onSelect={() => setSelected(block.id)}
                onMove={(to) => move(index, to)}
                onRemove={() => remove(index)}
              >
                {block.type === 'richText' ? (
                  <RichTextField
                    value={block.html}
                    // The editor reports its content once it mounts: that is no edit.
                    onChange={(html) => {
                      if (html !== block.html) replace(index, { ...block, html });
                    }}
                    disabled={disabled}
                    minHeight={200}
                  />
                ) : (
                  <VideoBlockBody
                    block={block}
                    disabled={disabled}
                    onChange={(next) => replace(index, next)}
                  />
                )}
              </BlockCard>
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {disabled ? null : (
        <Space wrap>
          <Button icon={<FileTextOutlined />} disabled={full} onClick={() => add('richText')}>
            添加富文本
          </Button>
          <Button icon={<VideoCameraOutlined />} disabled={full} onClick={() => add('video')}>
            添加视频
          </Button>
          <Typography.Text type="secondary">
            {full
              ? `最多 ${DESCRIPTION_BLOCKS_MAX} 个`
              : selectedIndex >= 0
                ? `添加在第 ${selectedIndex + 1} 个之后`
                : '添加在最后'}
          </Typography.Text>
        </Space>
      )}
    </Space>
  );
}

function VideoBlockBody({
  block,
  disabled,
  onChange,
}: {
  block: Extract<Block, { type: 'video' }>;
  disabled: boolean;
  onChange: (block: Extract<Block, { type: 'video' }>) => void;
}) {
  const bare = { id: block.id, type: block.type, src: block.src };
  return (
    <Space size={24} align="start" wrap>
      <Space direction="vertical" size={4}>
        <Typography.Text type="secondary">视频（mp4）</Typography.Text>
        <VideoAssetField
          value={block.src}
          poster={block.posterUrl}
          label="详情视频"
          disabled={disabled}
          onChange={(src) => onChange({ ...block, src: src ?? '' })}
        />
        {block.src.trim() === '' ? (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            请选择视频
          </Typography.Text>
        ) : null}
      </Space>
      <Space direction="vertical" size={4}>
        <Typography.Text type="secondary">封面（不选则显示黑底和播放键）</Typography.Text>
        <AssetField
          value={block.posterUrl}
          size={96}
          disabled={disabled}
          onChange={(url) =>
            onChange(typeof url === 'string' && url !== '' ? { ...bare, posterUrl: url } : bare)
          }
        />
      </Space>
    </Space>
  );
}

function BlockCard({
  block,
  index,
  count,
  selected,
  disabled,
  onSelect,
  onMove,
  onRemove,
  children,
}: {
  block: Block;
  index: number;
  count: number;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.id, disabled });
  const title = `${KIND_TEXT[block.type]} · 第 ${index + 1} 个`;
  const removeButton = (onClick?: () => void) => (
    <Button
      size="small"
      type="text"
      danger
      icon={<DeleteOutlined />}
      aria-label={`删除${title}`}
      onClick={onClick}
    >
      删除
    </Button>
  );
  return (
    <div
      ref={setNodeRef}
      data-testid="description-block"
      data-selected={selected ? 'true' : undefined}
      onClickCapture={onSelect}
      onFocusCapture={onSelect}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        border: `1px solid ${selected ? 'var(--ant-color-primary)' : 'var(--ant-color-border-secondary)'}`,
        boxShadow: selected ? '0 0 0 2px var(--ant-color-primary-bg)' : undefined,
        borderRadius: 8,
        background: 'var(--ant-color-bg-container)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderBottom: '1px solid var(--ant-color-border-secondary)',
        }}
      >
        {disabled ? null : (
          <Button
            ref={setActivatorNodeRef}
            size="small"
            type="text"
            icon={<HolderOutlined />}
            aria-label={`拖动${title}`}
            title="拖动调整顺序"
            style={{ cursor: 'grab' }}
            {...attributes}
            {...listeners}
          />
        )}
        <Typography.Text strong style={{ flex: 1 }}>
          {title}
        </Typography.Text>
        {disabled ? null : (
          <>
            <Button
              size="small"
              type="text"
              icon={<ArrowUpOutlined />}
              aria-label={`上移${title}`}
              disabled={index === 0}
              onClick={() => onMove(index - 1)}
            >
              上移
            </Button>
            <Button
              size="small"
              type="text"
              icon={<ArrowDownOutlined />}
              aria-label={`下移${title}`}
              disabled={index === count - 1}
              onClick={() => onMove(index + 1)}
            >
              下移
            </Button>
            {hasContent(block) ? (
              <Popconfirm
                title={`删除这个${KIND_TEXT[block.type]}？`}
                description="保存后，商品页上就不再显示它。"
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={onRemove}
              >
                {removeButton()}
              </Popconfirm>
            ) : (
              removeButton(onRemove)
            )}
          </>
        )}
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}
