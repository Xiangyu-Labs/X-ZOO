import type { CustomFieldRender, Field } from '@puckeditor/core';
import {
  carouselProps,
  imageCubeProps,
  orderEntryProps,
  productGridProps,
  serviceGridProps,
} from '@shop/contracts/decor/all-blocks';
import { blockVisibility } from '@shop/contracts/decor/base';
import { pageRootProps } from '@shop/contracts/decor/document';
import { ui } from '@shop/contracts/decor/meta';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  GROUP_FIELD_PREFIX,
  SEMANTIC_FIELD_KINDS,
  defaultsOf,
  initialPropsOf,
  zodToPuckFields,
  type CustomFieldRenderers,
} from './zod-to-puck';

const stub = (kind: string): CustomFieldRender<unknown> =>
  Object.assign(() => null as never, { kind });

/** The semantic kinds only. */
const kindsOnly = Object.fromEntries(
  SEMANTIC_FIELD_KINDS.map((kind) => [kind, stub(kind)]),
) as unknown as CustomFieldRenderers;

/** Without switch / choice: booleans and enums fall back to Puck's own controls. */
const semantic: CustomFieldRenderers = { ...kindsOnly, multiChoice: stub('multiChoice') };

/** Everything, as the admin passes it. */
const full: CustomFieldRenderers = {
  ...semantic,
  switch: stub('switch'),
  choice: stub('choice'),
  multiChoice: stub('multiChoice'),
  groupHeading: stub('groupHeading'),
};

type AnyField = Field & Record<string, any>;

function field(fields: Record<string, Field>, name: string): AnyField {
  const found = fields[name];
  if (!found) throw new Error(`no field ${name}`);
  return found as AnyField;
}

describe('zodToPuckFields — without the switch and choice controls', () => {
  it('maps every carousel prop to a control, with the schema label', () => {
    const fields = zodToPuckFields(carouselProps, semantic);
    expect(Object.keys(fields)).toEqual([
      'slides',
      'height',
      'autoplay',
      'interval',
      'indicator',
      'indicatorColor',
      'indicatorActiveColor',
      'style',
      'visibility',
    ]);
    expect(field(fields, 'height')).toMatchObject({
      type: 'number',
      label: '高度（750 设计稿 px）',
      min: 100,
      max: 1000,
      step: 10,
    });
    // Puck has no switch: a boolean becomes a 开/关 radio over real booleans.
    expect(field(fields, 'autoplay')).toMatchObject({
      type: 'radio',
      options: [
        { label: '开', value: true },
        { label: '关', value: false },
      ],
    });
    expect(field(fields, 'indicator')).toMatchObject({
      type: 'radio',
      options: [
        { label: '显示', value: 'dots' },
        { label: '隐藏', value: 'none' },
      ],
    });
    expect(field(fields, 'indicatorColor')).toMatchObject({
      type: 'custom',
      render: semantic.color,
    });
  });

  it('turns an array of objects into an array field with bounds, new-item props and a summary', () => {
    const slides = field(zodToPuckFields(carouselProps, semantic), 'slides');
    expect(slides).toMatchObject({ type: 'array', label: '图片', min: 1, max: 10 });
    expect(Object.keys(slides.arrayFields)).toEqual(['image', 'link', 'alt']);
    expect(slides.arrayFields.image).toMatchObject({ type: 'custom', render: semantic.image });
    // The optional link says so, so the link control can offer 不跳转.
    expect(slides.arrayFields.link).toMatchObject({
      type: 'custom',
      render: semantic.link,
      metadata: { optional: true },
    });
    expect(slides.defaultItemProps()).toEqual({ image: '', alt: '' });
    expect(slides.getItemSummary({ alt: '秋季上新' }, 0)).toBe('秋季上新');
    expect(slides.getItemSummary({ alt: '' }, 2)).toBe('图片 3');
  });

  it('uses a select past four choices and when the schema asks for one', () => {
    const cube = zodToPuckFields(imageCubeProps, semantic);
    const layout = field(cube, 'layout');
    expect(layout.type).toBe('select');
    expect(layout.options).toContainEqual({ label: '左一右二', value: 'left1right2' });
    expect(field(cube, 'cells')).toMatchObject({ type: 'array', min: 1, max: 4 });
    // The four spacing presets stay side by side.
    const style = field(cube, 'style');
    expect(style.objectFields.marginY).toMatchObject({
      type: 'radio',
      options: [
        { label: '无', value: 'none' },
        { label: '小', value: 'sm' },
        { label: '中', value: 'md' },
        { label: '大', value: 'lg' },
      ],
    });
  });

  it('refuses an array of an enum it has no multi-select for', () => {
    expect(() => zodToPuckFields(blockVisibility, kindsOnly)).toThrow(
      /no editor control for "platforms"/,
    );
  });
});

describe('zodToPuckFields — with the admin controls', () => {
  it('routes booleans to the switch and enums to the choice, typed options and control kept', () => {
    const fields = zodToPuckFields(productGridProps, full);
    expect(field(fields, 'showTag')).toMatchObject({ type: 'custom', render: full.switch });
    expect(field(fields, 'titleLines')).toMatchObject({
      type: 'custom',
      render: full.choice,
      metadata: {
        control: 'radio',
        options: [
          { label: '一行', value: 1 },
          { label: '两行', value: 2 },
        ],
      },
    });
    const layout = field(zodToPuckFields(imageCubeProps, full), 'layout');
    expect(layout.metadata?.control).toBe('select');
  });

  it('draws visibility.platforms as a multi-select, bounded, with the platform labels', () => {
    const visibility = field(zodToPuckFields(carouselProps, full), 'visibility');
    expect(visibility.objectFields.platforms).toMatchObject({
      type: 'custom',
      render: full.multiChoice,
      label: '仅在这些客户端显示（不选即全部）',
      metadata: {
        max: 3,
        options: [
          { label: '微信小程序', value: 'wechat-mini' },
          { label: 'H5', value: 'h5' },
          { label: '公众号网页', value: 'wechat-oa' },
        ],
      },
    });
  });

  it('gives every semantic kind its own renderer', () => {
    const schema = z.object(
      Object.fromEntries(
        SEMANTIC_FIELD_KINDS.map((kind) => [
          kind,
          z.unknown().meta(ui({ label: kind, field: kind })),
        ]),
      ),
    );
    const fields = zodToPuckFields(schema, full);
    for (const kind of SEMANTIC_FIELD_KINDS) {
      expect(field(fields, kind)).toMatchObject({ type: 'custom', render: full[kind] });
    }
  });

  it('inserts group headings in first-appearance order, but not over a self-titled object', () => {
    const fields = zodToPuckFields(carouselProps, full);
    expect(Object.keys(fields)).toEqual([
      `${GROUP_FIELD_PREFIX}内容`,
      'slides',
      'height',
      `${GROUP_FIELD_PREFIX}播放`,
      'autoplay',
      'interval',
      'indicator',
      'indicatorColor',
      'indicatorActiveColor',
      // 样式 and 显示 are single objects labelled with the group: their frame is the heading.
      'style',
      'visibility',
    ]);
    expect(field(fields, `${GROUP_FIELD_PREFIX}播放`)).toMatchObject({
      type: 'custom',
      label: '播放',
      render: full.groupHeading,
    });
    const root = zodToPuckFields(pageRootProps, full);
    expect(Object.keys(root)).toEqual([
      'title',
      'background',
      `${GROUP_FIELD_PREFIX}分享`,
      'shareEnabled',
      'shareTitle',
      'shareImage',
    ]);
  });

  it('builds every registered 个人中心 block without an unsupported prop', () => {
    expect(() => zodToPuckFields(orderEntryProps, full)).not.toThrow();
    const items = field(zodToPuckFields(serviceGridProps, full), 'items');
    expect(Object.keys(items.arrayFields)).toEqual(['label', 'icon', 'action', 'link']);
  });

  it('honours textarea, placeholder and hidden from the metadata', () => {
    const schema = z.object({
      intro: z.string().meta(ui({ label: '简介', field: 'textarea', placeholder: '一句话' })),
      internal: z.string().meta(ui({ label: '内部', hidden: true })),
    });
    expect(zodToPuckFields(schema, full)).toEqual({
      intro: expect.objectContaining({ type: 'textarea', label: '简介', placeholder: '一句话' }),
    });
  });

  it('refuses a prop it has no control for, unless a fallback renderer is given', () => {
    const schema = z.object({ extra: z.record(z.string(), z.string()) });
    expect(() => zodToPuckFields(schema, full)).toThrow(/no editor control for "extra"/);
    const unsupported = stub('unsupported');
    expect(zodToPuckFields(schema, { ...full, unsupported })).toEqual({
      extra: expect.objectContaining({ type: 'custom', label: 'extra', render: unsupported }),
    });
  });
});

describe('defaultsOf / initialPropsOf', () => {
  it('fills schema defaults, including the inner defaults of a prefault object', () => {
    expect(defaultsOf(productGridProps)).toEqual({
      source: { mode: 'manual', ids: [] },
      layout: 'grid2',
      titleLines: 2,
      showMarketPrice: true,
      showTag: true,
      style: { marginY: 'none', paddingX: 'none', radius: 'none' },
      visibility: { audience: 'all', platforms: [] },
    });
  });

  it('starts a required list with its minimum items, from the item defaults', () => {
    expect(initialPropsOf(carouselProps).slides).toEqual([{ image: '', alt: '' }]);
    expect(initialPropsOf(serviceGridProps).items).toEqual([{ label: '', action: 'link' }]);
    // A list with a default keeps it.
    expect(initialPropsOf(orderEntryProps).items).toHaveLength(5);
  });
});
