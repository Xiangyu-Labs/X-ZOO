import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { blockProps } from './base';
import { carouselProps, decorBlocks, imageCubeProps, productGridProps } from './all-blocks';
import { DECOR_LIMITS, ROUTE_LINK_LABELS } from './constants';
import { storefrontRouteDef, storefrontRouteKeys } from '../system/storefront-routes';
import { USER_CENTER_DEFAULT_DOCUMENT } from './defaults';
import {
  checkDocument,
  collectReferences,
  documentBytes,
  pageDocument,
  type StoredDocument,
} from './document';
import { linkTarget } from './link';
import { linkTargetRoute } from './link-route';
import { unwrapSchema } from './meta';
import {
  compareVersions,
  createBlockRegistry,
  defineBlock,
  migrateBlockProps,
  type AnyBlockDefinition,
} from './registry';

const IMAGE = 'https://cdn.example.com/a.jpg';

const carousel = {
  slides: [{ image: IMAGE, link: { kind: 'product', id: '12' }, alt: '' }],
};

function doc(blocks: StoredDocument['blocks'], title = '首页'): StoredDocument {
  return { schemaVersion: 2, root: { props: { title } }, blocks };
}

function checked(input: unknown, kind?: 'home' | 'user_center' | 'custom') {
  const result = checkDocument(input, { kind });
  if (!result.ok) throw new Error(`envelope refused: ${JSON.stringify(result.issues)}`);
  return result;
}

describe('block prop schemas', () => {
  it('fill every default, base props included, from a nearly empty input', () => {
    expect(productGridProps.parse({})).toEqual({
      source: { mode: 'manual', ids: [] },
      layout: 'grid2',
      titleLines: 2,
      showMarketPrice: true,
      showTag: true,
      style: { marginY: 'none', paddingX: 'none', radius: 'none' },
      visibility: { audience: 'all', platforms: [] },
    });
    expect(imageCubeProps.shape.visibility).toBeDefined();
  });

  it('carry editor metadata through optional / default wrappers', () => {
    const height = unwrapSchema(carouselProps.shape.height);
    expect(height.meta?.label).toBe('高度（750 设计稿 px）');
    expect(height.defaultValue).toBe(340);
    const link = unwrapSchema(carouselProps.shape.slides.element.shape.link);
    expect(link.meta).toMatchObject({ label: '跳转链接', field: 'link' });
    expect(link.optional).toBe(true);
    expect(unwrapSchema(productGridProps.shape.source).meta?.field).toBe('productSource');
  });

  it('labels every field the editor shows (meta convention 1)', () => {
    const unlabelled: string[] = [];
    const visit = (schema: z.ZodType, path: string) => {
      const { schema: inner, meta } = unwrapSchema(schema);
      if (!meta?.label) unlabelled.push(path);
      if (meta?.field === 'link' || meta?.field?.endsWith('Source')) return;
      const def = inner._zod.def as {
        type: string;
        shape?: Record<string, z.ZodType>;
        element?: z.ZodType;
      };
      if (def.type === 'object' && def.shape) {
        for (const [key, child] of Object.entries(def.shape)) visit(child, `${path}.${key}`);
      }
      if (def.type === 'array' && def.element) {
        const element = unwrapSchema(def.element).schema._zod.def as {
          type: string;
          shape?: Record<string, z.ZodType>;
        };
        for (const [key, child] of Object.entries(element.shape ?? {}))
          visit(child, `${path}[].${key}`);
      }
    };
    for (const definition of decorBlocks.list()) {
      for (const [key, child] of Object.entries(definition.props.shape)) {
        visit(child as z.ZodType, `${definition.type}.${key}`);
      }
    }
    expect(unlabelled).toEqual([]);
  });
});

describe('defineBlock — DECOR-001', () => {
  const props = blockProps({ text: z.string().default('').meta({ label: '文字' }) });
  const base = { type: 'note', v: 1, props, meta: { label: '文字', pages: ['custom'] as const } };

  it('refuses a props schema without the base props', () => {
    expect(() => defineBlock({ ...base, props: z.object({ text: z.string() }) as never })).toThrow(
      /blockProps/,
    );
  });

  it('refuses a version without a migration for every older version', () => {
    expect(() => defineBlock({ ...base, v: 3, migrate: { 1: (p) => p } })).toThrow(/1, 2/);
    expect(() => defineBlock({ ...base, v: 1, migrate: { 1: (p) => p } })).toThrow(/none/);
    expect(defineBlock({ ...base, v: 2, migrate: { 1: (p) => p } }).v).toBe(2);
  });

  it('refuses a bad type name, a bad minClient and a registry with a type twice', () => {
    expect(() => defineBlock({ ...base, type: 'Bad-Type' })).toThrow(/camelCase/);
    expect(() => defineBlock({ ...base, meta: { ...base.meta, minClient: 'v2' } })).toThrow(
      /minClient/,
    );
    const note = defineBlock(base) as AnyBlockDefinition;
    expect(() => createBlockRegistry([note, note])).toThrow(/twice/);
  });

  it('migrates stored props step by step up to the current version', () => {
    const v3 = defineBlock({
      ...base,
      v: 3,
      migrate: {
        1: (p) => ({ ...p, text: `${String(p.body ?? '')}` }),
        2: (p) => ({ ...p, text: String(p.text).toUpperCase() }),
      },
    }) as AnyBlockDefinition;
    expect(migrateBlockProps(v3, 1, { body: 'hi' })).toEqual({
      ok: true,
      props: { body: 'hi', text: 'HI' },
    });
    expect(migrateBlockProps(v3, 4, {})).toEqual({ ok: false, reason: 'newer' });
    const broken = {
      ...v3,
      migrate: {
        1: () => {
          throw new Error('boom');
        },
        2: (p: Record<string, unknown>) => p,
      },
    };
    expect(migrateBlockProps(broken, 1, {})).toMatchObject({
      ok: false,
      reason: 'failed',
      message: 'boom',
    });
  });

  it('compares client versions numerically, and a garbled one as unknown', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('latest', '1.0.0')).toBeNull();
  });
});

describe('LinkTarget — DECOR-002', () => {
  it('is a typed target, never a path string', () => {
    expect(linkTarget.safeParse({ kind: 'product', id: '12' }).success).toBe(true);
    expect(linkTarget.safeParse('/pages/goods_details/index?id=12').success).toBe(false);
    expect(linkTarget.safeParse({ kind: 'route', route: 'cart' }).success).toBe(false);
  });

  it('links to catalogue routes by key with strict params, linkable keys only', () => {
    expect(linkTarget.safeParse({ kind: 'route', to: { route: 'cart', params: {} } }).success).toBe(
      true,
    );
    expect(
      linkTarget.safeParse({ kind: 'route', to: { route: 'orderList', params: { tab: 'unpaid' } } })
        .success,
    ).toBe(true);
    // not linkable: the checkout needs a cart state a link cannot carry
    expect(
      linkTarget.safeParse({ kind: 'route', to: { route: 'checkout', params: {} } }).success,
    ).toBe(false);
    // strict params
    expect(
      linkTarget.safeParse({ kind: 'route', to: { route: 'cart', params: { x: '1' } } }).success,
    ).toBe(false);
  });

  it('labels exactly the linkable routes that need no params', () => {
    const plain = storefrontRouteKeys.filter(
      (key) =>
        storefrontRouteDef(key).linkable === true &&
        storefrontRouteDef(key).params.safeParse({}).success,
    );
    expect(Object.keys(ROUTE_LINK_LABELS).sort()).toEqual([...plain].sort());
  });

  it('opens only https pages in a web-view and checks a mini-program AppID', () => {
    expect(linkTarget.safeParse({ kind: 'webview', url: 'http://example.com' }).success).toBe(
      false,
    );
    expect(linkTarget.safeParse({ kind: 'miniprogram', appId: 'wx123' }).success).toBe(false);
    expect(
      linkTarget.safeParse({ kind: 'miniprogram', appId: 'wx0123456789abcdef', path: 'pages/a' })
        .success,
    ).toBe(true);
  });

  it('resolves to a catalogue route without zod', () => {
    expect(linkTargetRoute({ kind: 'category', id: '3' })).toEqual({
      route: 'productList',
      params: { categoryId: '3' },
    });
    expect(linkTargetRoute({ kind: 'page', id: '9' })).toEqual({
      route: 'page',
      params: { id: '9' },
    });
    expect(linkTargetRoute({ kind: 'webview', url: 'https://a.example.com' })).toBeNull();
  });
});

describe('checkDocument — DECOR-003', () => {
  it('parses every known block and fills its defaults', () => {
    const result = checked(
      doc([
        { id: 'a', type: 'carousel', v: 1, props: carousel },
        { id: 'b', type: 'productGrid', v: 1, props: { source: { mode: 'manual', ids: ['12'] } } },
      ]),
      'home',
    );
    expect(result.issues).toEqual([]);
    expect(result.document.blocks[1]?.props).toMatchObject({ titleLines: 2, showTag: true });
    expect(result.document.root.props).toMatchObject({ title: '首页', shareEnabled: true });
  });

  it('keeps an unknown block type as it came, warns, and blocks publishing it', () => {
    const future = { id: 'z', type: 'fromTheFuture', v: 3, props: { x: 1 } };
    const result = checked(doc([{ id: 'a', type: 'carousel', v: 1, props: carousel }, future]));
    expect(result.unknownBlocks).toEqual(['fromTheFuture']);
    expect(result.document.blocks[1]).toEqual(future);
    expect(result.warnings).toHaveLength(1);
    expect(result.issues.map((issue) => issue.path)).toEqual(['blocks.1.type']);
  });

  it('treats a known type stored at a newer version like an unknown one', () => {
    const result = checked(doc([{ id: 'a', type: 'carousel', v: 9, props: carousel }]));
    expect(result.unknownBlocks).toEqual(['carousel']);
    expect(result.document.blocks[0]?.v).toBe(9);
    expect(result.issues[0]?.path).toBe('blocks.0.v');
  });

  it('saves invalid props as they came and reports them with a path', () => {
    const result = checked(
      doc([{ id: 'a', type: 'carousel', v: 1, props: { ...carousel, slides: [] } }]),
    );
    expect(result.issues).toEqual([{ path: 'blocks.0.props.slides', message: '至少一张图片' }]);
    expect(result.document.blocks[0]?.props).toEqual({ ...carousel, slides: [] });
  });

  it('reports invalid root props without refusing the draft', () => {
    const result = checked(doc([], ''));
    expect(result.issues).toEqual([{ path: 'root.props.title', message: '请填写页面标题' }]);
    expect(result.document.root.props).toEqual({ title: '' });
  });

  it('refuses duplicate block ids, and blocks on a page kind that may not hold them', () => {
    const block = { id: 'a', type: 'carousel', v: 1, props: carousel };
    expect(checked(doc([block, block])).issues[0]?.message).toContain('重复');
    const card = { id: 'u', type: 'userCard', v: 1, props: {} };
    expect(checked(doc([card]), 'home').issues[0]?.message).toContain('不能使用');
    expect(checked(doc([card]), 'user_center').issues).toEqual([]);
    expect(checked(doc([card, { ...card, id: 'u2' }]), 'user_center').issues[0]?.message).toContain(
      '最多 1 个',
    );
  });

  it('refuses the envelope outright: schema version, block count, byte size', () => {
    expect(checkDocument({ ...doc([]), schemaVersion: 1 }).ok).toBe(false);
    const many = Array.from({ length: DECOR_LIMITS.blocks + 1 }, (_, index) => ({
      id: `b${index}`,
      type: 'carousel',
      v: 1,
      props: carousel,
    }));
    expect(checkDocument(doc(many)).ok).toBe(false);
    const huge = doc([
      {
        id: 'a',
        type: 'carousel',
        v: 1,
        props: { ...carousel, pad: 'x'.repeat(DECOR_LIMITS.documentBytes) },
      },
    ]);
    expect(documentBytes(huge)).toBeGreaterThan(DECOR_LIMITS.documentBytes);
    const result = checkDocument(huge);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('过大');
  });

  it('limits the blocks that need server data', () => {
    const grids = Array.from({ length: DECOR_LIMITS.dataBlocks + 1 }, (_, index) => ({
      id: `g${index}`,
      type: 'productGrid',
      v: 1,
      props: {},
    }));
    const result = checked(doc(grids));
    expect(result.issues.map((issue) => issue.path)).toEqual(['blocks']);
  });
});

describe('collectReferences — DECOR-004', () => {
  it('finds links and sources through the editor metadata, not by block name', () => {
    const result = checked(
      doc([
        {
          id: 'a',
          type: 'carousel',
          v: 1,
          props: {
            slides: [
              { image: IMAGE, link: { kind: 'product', id: '12' } },
              { image: IMAGE, link: { kind: 'page', id: '4' } },
              { image: IMAGE, link: { kind: 'route', to: { route: 'cart', params: {} } } },
              { image: IMAGE },
            ],
          },
        },
        {
          id: 'b',
          type: 'productGrid',
          v: 1,
          props: { source: { mode: 'manual', ids: ['5', '6'] } },
        },
        {
          id: 'c',
          type: 'productGrid',
          v: 1,
          props: { source: { mode: 'label', labelId: '2', sort: 'sales', limit: 4 } },
        },
        { id: 'z', type: 'unknownThing', v: 1, props: { link: { kind: 'product', id: '99' } } },
      ]),
    );
    expect(collectReferences(result.document)).toEqual([
      { kind: 'product', id: '12', path: 'blocks.0.props.slides.0.link' },
      { kind: 'page', id: '4', path: 'blocks.0.props.slides.1.link' },
      { kind: 'product', id: '5', path: 'blocks.1.props.source.ids.0' },
      { kind: 'product', id: '6', path: 'blocks.1.props.source.ids.1' },
      { kind: 'productLabel', id: '2', path: 'blocks.2.props.source.labelId' },
    ]);
  });
});

describe('the built-in 个人中心 — DECOR-005', () => {
  it('passes the strict check for a user-centre page, unchanged', () => {
    const result = checked(USER_CENTER_DEFAULT_DOCUMENT, 'user_center');
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(pageDocument.parse(result.document)).toEqual(USER_CENTER_DEFAULT_DOCUMENT);
  });
});

describe('zod-free runtime modules', () => {
  // The mini-program imports these at runtime; its bundle must not carry zod.
  const ZOD_FREE = ['constants.ts', 'link-route.ts', 'defaults.ts', 'meta.ts', 'rich-text.ts'];
  it.each(ZOD_FREE)('%s has no value import that can reach zod', (file) => {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8');
    const valueImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)].map(
      (match) => match[1],
    );
    expect(valueImports).toEqual([]);
  });
});
