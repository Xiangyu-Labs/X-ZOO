import type { Data } from '@puckeditor/core';
import { decorBlocks } from '@shop/contracts/decor/all-blocks';
import { blockProps } from '@shop/contracts/decor/base';
import { checkDocument, type StoredDocument } from '@shop/contracts/decor/document';
import { ui } from '@shop/contracts/decor/meta';
import { createBlockRegistry, defineBlock } from '@shop/contracts/decor/registry';
import {
  fixtureCarousel,
  fixtureImageCube,
  fixtureProductGrid,
} from '@shop/storefront-blocks/fixtures';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { newBlockProps } from './config';
import {
  DecorConversionError,
  UNKNOWN_BLOCK,
  canonicalJson,
  toPageDocument,
  toPuckData,
} from './document';

/** Editor data in the shape Puck 0.23 hands to `onChange`. */
const puckData = {
  root: {
    props: { title: '装修试验页', background: '#f5f5f5', shareEnabled: true, shareTitle: '' },
  },
  content: [
    {
      type: 'carousel',
      props: { id: 'carousel-0b8c6a3e-3f0d-4a47-9d0e-5b1d2b7c9f10', ...fixtureCarousel },
    },
    {
      type: 'productGrid',
      props: { id: 'productGrid-6a1f', ...fixtureProductGrid },
    },
    {
      type: 'imageCube',
      props: { id: 'imageCube-77e2', ...fixtureImageCube },
    },
  ],
} as Data;

describe('editor data ⇄ page document', () => {
  it('round-trips Puck data through the document without losing anything', () => {
    const document = toPageDocument(structuredClone(puckData));
    expect(toPuckData(document)).toEqual(puckData);
  });

  it('round-trips a document through the editor data without losing anything', () => {
    const document = toPageDocument(puckData);
    // Through JSON as well: what is stored is what comes back.
    const stored = JSON.parse(JSON.stringify(document)) as StoredDocument;
    expect(toPageDocument(toPuckData(stored))).toEqual(stored);
  });

  it('writes the v2 envelope: ids beside the props, the current block version', () => {
    const document = toPageDocument(puckData);
    expect(document.schemaVersion).toBe(2);
    expect(document.blocks.map(({ id, type, v }) => ({ id, type, v }))).toEqual([
      { id: 'carousel-0b8c6a3e-3f0d-4a47-9d0e-5b1d2b7c9f10', type: 'carousel', v: 1 },
      { id: 'productGrid-6a1f', type: 'productGrid', v: 2 },
      { id: 'imageCube-77e2', type: 'imageCube', v: 1 },
    ]);
    expect(document.blocks[0]?.props).not.toHaveProperty('id');
    const checked = checkDocument(document, { registry: decorBlocks, kind: 'custom' });
    expect(checked).toMatchObject({ ok: true, issues: [] });
  });

  it('fills root props the stored draft lacks from the schema defaults', () => {
    const data = toPuckData({ schemaVersion: 2, root: { props: {} }, blocks: [] });
    expect(data.root.props).toEqual({
      title: '微页面',
      background: '#f5f5f5',
      shareEnabled: true,
      shareTitle: '',
    });
  });

  it('keeps a newly inserted block invalid until its images are picked', () => {
    const data: Data = {
      ...puckData,
      content: [
        {
          type: 'carousel',
          props: { id: 'carousel-new', ...newBlockProps(decorBlocks.get('carousel')!) },
        },
      ],
    };
    const checked = checkDocument(toPageDocument(data), { registry: decorBlocks, kind: 'custom' });
    expect(checked).toMatchObject({
      ok: true,
      issues: [{ path: 'blocks.0.props.slides.0.image', message: '请选择图片' }],
    });
  });

  it('starts a new image cube with as many cells as its layout shows', () => {
    const props = newBlockProps(decorBlocks.get('imageCube')!);
    expect(props.layout).toBe('left1right2');
    expect(props.cells).toHaveLength(3);
  });

  it('drops the inspector group headings from what it saves', () => {
    const data = structuredClone(puckData);
    (data.content[0]!.props as Record<string, unknown>)['__group:播放'] = 'stray';
    (data.root as { props: Record<string, unknown> }).props['__group:分享'] = 'stray';
    const document = toPageDocument(data);
    expect(document.blocks[0]?.props).not.toHaveProperty('__group:播放');
    expect(document.root.props).not.toHaveProperty('__group:分享');
  });

  it('accepts an empty zones map and refuses a non-empty one', () => {
    expect(toPageDocument({ ...puckData, zones: {} }).blocks).toHaveLength(3);
    expect(() =>
      toPageDocument({
        ...puckData,
        zones: { 'carousel-x:inner': [{ type: 'carousel', props: { id: 'y' } }] },
      }),
    ).toThrow(DecorConversionError);
  });
});

describe('blocks this build cannot edit', () => {
  const stored = toPageDocument(puckData);

  it('carries an unknown type through untouched, in its place', () => {
    const future = { id: 'video-1', type: 'videoPlayer', v: 1, props: { src: 'x' } };
    const document: StoredDocument = { ...stored, blocks: [stored.blocks[0]!, future] };
    const data = toPuckData(document);
    expect(data.content[1]).toMatchObject({
      type: UNKNOWN_BLOCK,
      props: { id: 'video-1', block: future, reason: expect.stringContaining('videoPlayer') },
    });
    expect(toPageDocument(data)).toEqual(document);
  });

  it('carries a block stored at a newer version through untouched', () => {
    const newer = { ...stored.blocks[0]!, v: 9 };
    const data = toPuckData({ ...stored, blocks: [newer] });
    expect(data.content[0]).toMatchObject({ type: UNKNOWN_BLOCK });
    expect(toPageDocument(data).blocks).toEqual([newer]);
  });

  describe('an older version', () => {
    const note = defineBlock({
      type: 'note',
      v: 2,
      props: blockProps({
        text: z
          .string()
          .default('')
          .meta(ui({ label: '文字' })),
      }),
      meta: { label: '便签', pages: ['custom'] },
      migrate: {
        1: ({ body, ...rest }) => {
          if (typeof body !== 'string') throw new Error('body 缺失');
          return { ...rest, text: body };
        },
      },
    });
    const registry = createBlockRegistry([note]);
    const base: StoredDocument = { schemaVersion: 2, root: { props: {} }, blocks: [] };

    it('is migrated on the way in and saved at the current version', () => {
      const data = toPuckData(
        { ...base, blocks: [{ id: 'n1', type: 'note', v: 1, props: { body: '你好' } }] },
        registry,
      );
      expect(data.content[0]).toEqual({ type: 'note', props: { id: 'n1', text: '你好' } });
      expect(toPageDocument(data, registry).blocks).toEqual([
        { id: 'n1', type: 'note', v: 2, props: { text: '你好' } },
      ]);
    });

    it('is carried through untouched when its migration fails', () => {
      const broken = { id: 'n2', type: 'note', v: 1, props: {} };
      const data = toPuckData({ ...base, blocks: [broken] }, registry);
      expect(data.content[0]).toMatchObject({
        type: UNKNOWN_BLOCK,
        props: { reason: expect.stringContaining('body 缺失') },
      });
      expect(toPageDocument(data, registry).blocks).toEqual([broken]);
    });
  });
});

describe('canonicalJson', () => {
  it('ignores key order and undefined values, but not a real change', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: undefined } })).toBe(
      canonicalJson({ b: { c: 2 }, a: 1 }),
    );
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});
