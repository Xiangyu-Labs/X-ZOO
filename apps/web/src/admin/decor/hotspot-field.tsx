'use client';

import { DeleteOutlined } from '@ant-design/icons';
import { createUsePuck, FieldLabel, type CustomFieldRender } from '@puckeditor/core';
import type { Hotspot, LinkTarget } from '@shop/storefront-blocks/schema';
import { Button, Input, InputNumber, Space, Typography } from 'antd';
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import type { DecorFieldMetadata } from './zod-to-puck';

/**
 * The 热区 control of 热区图 (`field: 'hotspots'`): the block's picture, on
 * which the operator drags out rectangles. A tap on a rectangle selects it;
 * its box, 说明 and link are then edited below, the box also as numbers for
 * fine adjustment. Boxes are in percent of the picture, clamped inside it —
 * the same rule the schema checks (`热区超出图片范围`).
 */

type RenderProps<Value> = Parameters<CustomFieldRender<Value>>[0];

/** Renders one link control; `fields.tsx` passes its own `LinkField`. */
export type LinkControl = (props: RenderProps<LinkTarget | undefined>) => ReactNode;

export const MAX_HOTSPOTS = 20;
/** Smaller than this (in %) a drag is taken as a tap, not a new area. */
const MIN_SIZE = 2;

const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A box from two corners, in percent, inside the picture. */
export function boxFrom(
  a: { x: number; y: number },
  b: { x: number; y: number },
): Pick<Hotspot, 'x' | 'y' | 'w' | 'h'> {
  const x = round1(clamp(Math.min(a.x, b.x), 0, 100));
  const y = round1(clamp(Math.min(a.y, b.y), 0, 100));
  return {
    x,
    y,
    w: round1(clamp(Math.abs(a.x - b.x), 0, 100 - x)),
    h: round1(clamp(Math.abs(a.y - b.y), 0, 100 - y)),
  };
}

/** Keeps an edited box inside the picture: size first (≥ 1), then position. */
export function fitBox(spot: Hotspot): Hotspot {
  const w = round1(clamp(spot.w, 1, 100));
  const h = round1(clamp(spot.h, 1, 100));
  return {
    ...spot,
    w,
    h,
    x: round1(clamp(spot.x, 0, 100 - w)),
    y: round1(clamp(spot.y, 0, 100 - h)),
  };
}

const usePuck = createUsePuck();

/** The Puck custom field: reads the picture from the block being edited. */
export function HotspotField(
  props: RenderProps<Hotspot[] | undefined> & { renderLink: LinkControl },
) {
  const image = usePuck((state) => {
    const value = (state.selectedItem?.props as { image?: unknown } | undefined)?.image;
    return typeof value === 'string' ? value : '';
  });
  return <HotspotEditor {...props} image={image} />;
}

export function HotspotEditor({
  field,
  name,
  id,
  value,
  onChange,
  readOnly = false,
  image,
  renderLink,
}: RenderProps<Hotspot[] | undefined> & { image: string; renderLink: LinkControl }) {
  const spots = value ?? [];
  const stage = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<{
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null>(null);
  const full = spots.length >= MAX_HOTSPOTS;
  const current = selected !== null ? spots[selected] : undefined;

  const at = (event: ReactPointerEvent): { x: number; y: number } => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
    };
  };

  const update = (index: number, next: Hotspot) =>
    onChange(spots.map((spot, at) => (at === index ? fitBox(next) : spot)));

  const remove = (index: number) => {
    onChange(spots.filter((_spot, at) => at !== index));
    setSelected(null);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (readOnly || !image || full || event.target !== stage.current) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = at(event);
    setDraft({ start: point, end: point });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draft) setDraft({ ...draft, end: at(event) });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft) return;
    const box = boxFrom(draft.start, at(event));
    setDraft(null);
    if (box.w < MIN_SIZE || box.h < MIN_SIZE) {
      setSelected(null);
      return;
    }
    // No link until the operator picks one: a made-up default (the home page)
    // would publish a tap that goes somewhere nobody chose. The publish check
    // refuses the missing link (请选择跳转链接), and the box says so meanwhile.
    onChange([...spots, { ...box, label: '' } as Hotspot]);
    setSelected(spots.length);
  };

  const preview = draft ? boxFrom(draft.start, draft.end) : null;

  return (
    <FieldLabel label={field.label ?? name} el="div" readOnly={readOnly}>
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        {image ? (
          <div
            ref={stage}
            data-testid="hotspot-stage"
            role="presentation"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              position: 'relative',
              lineHeight: 0,
              cursor: readOnly || full ? 'default' : 'crosshair',
              userSelect: 'none',
              touchAction: 'none',
              border: '1px solid #e5e5e5',
            }}
          >
            <img
              src={image}
              alt=""
              draggable={false}
              style={{ width: '100%', display: 'block', pointerEvents: 'none' }}
            />
            {spots.map((spot, index) => (
              <button
                key={index}
                type="button"
                aria-label={`热区 ${index + 1}`}
                aria-pressed={index === selected}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setSelected(index)}
                style={boxStyle(spot, index === selected)}
              >
                {index + 1}
              </button>
            ))}
            {preview ? <div style={boxStyle(preview, true)} /> : null}
          </div>
        ) : (
          <Typography.Text type="secondary">先选择图片，再在图片上拖出热区</Typography.Text>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {full
            ? `最多 ${MAX_HOTSPOTS} 个热区`
            : `在图片上拖动画出热区（${spots.length}/${MAX_HOTSPOTS}），点选热区可修改`}
        </Typography.Text>
        {current && selected !== null ? (
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            <Space.Compact block>
              {(['x', 'y', 'w', 'h'] as const).map((key) => (
                <InputNumber<number>
                  key={key}
                  aria-label={AXIS_LABEL[key]}
                  prefix={AXIS_LABEL[key]}
                  value={current[key]}
                  min={key === 'w' || key === 'h' ? 1 : 0}
                  max={100}
                  step={0.5}
                  disabled={readOnly}
                  style={{ width: '25%' }}
                  onChange={(next) => {
                    if (typeof next === 'number') update(selected, { ...current, [key]: next });
                  }}
                />
              ))}
            </Space.Compact>
            <Input
              value={current.label}
              maxLength={20}
              placeholder="热区说明（读屏用，可不填）"
              disabled={readOnly}
              onChange={(event) => update(selected, { ...current, label: event.target.value })}
            />
            {renderLink({
              field: { type: 'custom', label: '跳转链接', metadata: LINK_METADATA } as never,
              name: `${name}.${selected}.link`,
              id: `${id}-${selected}-link`,
              value: current.link,
              readOnly,
              onChange: (link: LinkTarget | undefined) => {
                if (link) update(selected, { ...current, link });
              },
            })}
            {current.link ? null : (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                还没有选择跳转链接，选好之前页面不能发布
              </Typography.Text>
            )}
            <Button
              danger
              size="small"
              icon={<DeleteOutlined />}
              disabled={readOnly}
              onClick={() => remove(selected)}
            >
              删除热区 {selected + 1}
            </Button>
          </Space>
        ) : null}
      </Space>
    </FieldLabel>
  );
}

const AXIS_LABEL = { x: '左', y: '上', w: '宽', h: '高' } as const;
const LINK_METADATA: DecorFieldMetadata = { meta: undefined, optional: false };

function boxStyle(box: Pick<Hotspot, 'x' | 'y' | 'w' | 'h'>, active: boolean) {
  return {
    position: 'absolute',
    left: `${box.x}%`,
    top: `${box.y}%`,
    width: `${box.w}%`,
    height: `${box.h}%`,
    padding: 0,
    border: `1px ${active ? 'solid' : 'dashed'} #1677ff`,
    background: active ? 'rgba(22, 119, 255, 0.25)' : 'rgba(22, 119, 255, 0.12)',
    color: '#1677ff',
    fontSize: 12,
    lineHeight: '16px',
    textAlign: 'left',
    cursor: 'pointer',
  } as const;
}
