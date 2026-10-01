import { decorBlocks } from '@shop/contracts/decor/all-blocks';
import { DOCUMENT_KINDS, type DocumentKind } from '@shop/contracts/decor/constants';
import { checkDocument } from '@shop/contracts/decor/document';
import { describe, expect, it } from 'vitest';

import { IMAGE_PLACEHOLDER, withImagePlaceholders } from '../canvas-images';
import { BLANK_TEMPLATE_KEY, DECOR_TEMPLATES, templatesFor } from './index';

describe('page templates', () => {
  it('offers the blank page first, then at least one template for every page kind', () => {
    for (const kind of Object.keys(DOCUMENT_KINDS) as DocumentKind[]) {
      const offered = templatesFor(kind);
      expect(offered[0]?.key).toBe(BLANK_TEMPLATE_KEY);
      expect(offered.length, kind).toBeGreaterThan(1);
      expect(offered.every((template) => template.kind === kind)).toBe(true);
    }
    const keys = DECOR_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe.each(DECOR_TEMPLATES.map((template) => [template.key, template] as const))(
    '%s',
    (_key, template) => {
      const document = template.document!;
      const check = checkDocument(document, { kind: template.kind, registry: decorBlocks });

      it('is stored exactly as written: every block current, known and allowed on its kind', () => {
        expect(check.ok).toBe(true);
        if (!check.ok) return;
        expect(check.unknownBlocks).toEqual([]);
        expect(check.warnings).toEqual([]);
        for (const block of document.blocks) {
          expect(block.v, block.type).toBe(decorBlocks.get(block.type)?.v);
        }
        // Defaults written out and nothing migrated or cleaned on the way in.
        expect(check.document).toEqual(document);
        const ids = document.blocks.map((block) => block.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('holds back publishing only until the pictures are picked', () => {
        if (!check.ok) throw new Error('template does not check');
        for (const issue of check.issues) {
          expect(issue.path).toMatch(/\.(image|icon)$/);
          expect(issue.message).toBe('请选择图片');
        }
      });

      it('shows every empty picture on the canvas as the placeholder', () => {
        for (const block of document.blocks) {
          const schema = decorBlocks.get(block.type)!.props;
          const drawn = JSON.stringify(withImagePlaceholders(schema, block.props));
          expect(drawn).not.toMatch(/"(image|icon)":""/);
        }
        expect(JSON.stringify(document)).not.toContain(IMAGE_PLACEHOLDER);
      });
    },
  );
});
