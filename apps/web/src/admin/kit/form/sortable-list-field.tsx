'use client';

import { DeleteOutlined, HolderOutlined, PlusOutlined } from '@ant-design/icons';
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
import { Button, Empty } from 'antd';
import type { ReactNode } from 'react';

export interface SortableItemHelpers<T> {
  /** Shallow-merges a patch into this item. */
  update: (patch: Partial<T>) => void;
  /** Replaces this item wholesale. */
  set: (next: T) => void;
  remove: () => void;
  index: number;
  disabled: boolean;
}

export interface SortableListFieldProps<T> {
  value?: T[] | undefined;
  onChange?: ((value: T[]) => void) | undefined;
  /** Row body. The drag handle and the delete button are supplied around it. */
  renderItem: (item: T, helpers: SortableItemHelpers<T>) => ReactNode;
  /** Factory for the "add" button. Omit it to hide the button. */
  newItem?: (() => T) | undefined;
  addText?: string | undefined;
  max?: number | undefined;
  min?: number | undefined;
  disabled?: boolean | undefined;
  emptyText?: string | undefined;
}

/**
 * Ordered sub-items with drag-and-drop (dnd-kit), for things like SKU
 * attributes, banner slides or a coupon's rule rows.
 *
 * The value is a plain array in display order — reordering is the value
 * changing, there is no separate `sort` field to keep in step.
 *
 * ```tsx
 * { kind: 'sortableList', name: 'slides',
 *   newItem: () => ({ image: '', link: '' }),
 *   renderItem: (item, { update }) => (
 *     <Input value={item.link} onChange={(e) => update({ link: e.target.value })} />
 *   ) }
 * ```
 */
export function SortableListField<T>({
  value,
  onChange,
  renderItem,
  newItem,
  addText = '添加一项',
  max,
  min = 0,
  disabled = false,
  emptyText = '暂无内容',
}: SortableListFieldProps<T>) {
  const items = value ?? [];

  // dnd-kit needs an id per row. Sub-items are plain data with no id of their
  // own, so the position is the id: it is stable for the length of a drag,
  // which is all dnd-kit needs, and it keeps this component free of refs.
  const ids = items.map((_item, index) => String(index));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = Number(active.id);
    const to = Number(over.id);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    onChange?.(arrayMove(items, from, to));
  };

  const replaceAt = (index: number, next: T): void => {
    const copy = items.slice();
    copy[index] = next;
    onChange?.(copy);
  };

  const removeAt = (index: number): void => {
    onChange?.(items.filter((_item, i) => i !== index));
  };

  const canAdd = !disabled && newItem !== undefined && (max === undefined || items.length < max);
  const canRemove = (index: number): boolean => !disabled && items.length > min && index >= 0;

  return (
    <div>
      {items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={emptyText}
          style={{ margin: '8px 0' }}
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {items.map((item, index) => (
                <SortableRow
                  key={index}
                  id={String(index)}
                  disabled={disabled}
                  onRemove={canRemove(index) ? () => removeAt(index) : undefined}
                >
                  {renderItem(item, {
                    index,
                    disabled,
                    set: (next) => replaceAt(index, next),
                    update: (patch) => replaceAt(index, { ...item, ...patch }),
                    remove: () => removeAt(index),
                  })}
                </SortableRow>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {canAdd ? (
        <Button
          type="dashed"
          block
          icon={<PlusOutlined />}
          style={{ marginTop: 8 }}
          onClick={() => onChange?.([...items, newItem!()])}
        >
          {addText}
        </Button>
      ) : null}
    </div>
  );
}

function SortableRow({
  id,
  disabled,
  onRemove,
  children,
}: {
  id: string;
  disabled: boolean;
  onRemove?: (() => void) | undefined;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: 8,
        borderRadius: 6,
        border: '1px solid var(--ant-color-border-secondary)',
        background: 'var(--ant-color-bg-container)',
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <span
        {...attributes}
        {...listeners}
        aria-label="拖动排序"
        style={{
          cursor: disabled ? 'not-allowed' : 'grab',
          color: 'var(--ant-color-text-quaternary)',
        }}
      >
        <HolderOutlined />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {onRemove ? (
        <Button
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
          aria-label="删除"
          onClick={onRemove}
        />
      ) : null}
    </div>
  );
}
